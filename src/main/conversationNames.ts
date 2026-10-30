import Database from 'better-sqlite3-multiple-ciphers';
import { existsSync, readdirSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { clientHomes } from './clientHomes';

/** Titles change after a conversation starts (T3 Code renames threads), so title lists are reread at most this often. */
const TITLE_LIST_REFRESH_MS = 30_000;
/** Bounds one renderer request; a day of requests holds far fewer conversations. */
const MAX_IDS_PER_CALL = 1000;
/** Proxy session IDs: "<client>:<native id>", plus ":agent:<id>" for subagents (docs/desktop-api.md in the fork). */
const SESSION_ID = /^(claude|codex):(.+?)(?::agent:.+)?$/;
/** Claude Code names transcripts by session UUID; checked before it becomes part of a path. */
const CLAUDE_SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** T3 Code's own database (internal schema, read-only): each thread's provider session and its title. */
const T3_STATE_DB = path.join(os.homedir(), '.t3', 'userdata', 'statev2.sqlite');
const T3_TITLES_SQL = `
SELECT json_extract(p.payload_json, '$.nativeThreadRef.nativeId') AS native, t.title AS title
FROM orchestration_v2_projection_provider_threads p
JOIN orchestration_v2_projection_threads t ON t.thread_id = p.thread_id
WHERE native IS NOT NULL AND t.title IS NOT NULL AND t.title <> ''`;
/** Codex's thread database (internal schema, read-only); its index file only lists renamed threads. */
const CODEX_STATE_DB_NAME = 'state_5.sqlite';
/** A thread's name the user set, else the title Codex gave it. */
const CODEX_TITLES_SQL = `
SELECT id AS native, coalesce(nullif(name, ''), title) AS title FROM threads
WHERE coalesce(nullif(name, ''), title) <> ''`;

/** The client's own conversation ID inside a proxy session ID; null for clients without names. */
export function nativeConversationId(sessionId: string): { client: 'claude' | 'codex'; id: string } | null {
  const m = SESSION_ID.exec(sessionId);
  return m ? { client: m[1] as 'claude' | 'codex', id: m[2]! } : null;
}

/** A Claude Code transcript's title: one the user set wins over the generated one; the last of each counts. */
export function claudeTranscriptTitle(text: string): string | null {
  let custom: string | null = null;
  let generated: string | null = null;
  for (const line of text.split('\n')) {
    if (!line.includes('-title"')) continue;
    try {
      const r = JSON.parse(line) as { type?: unknown; customTitle?: unknown; aiTitle?: unknown };
      if (r.type === 'custom-title' && typeof r.customTitle === 'string' && r.customTitle) custom = r.customTitle;
      if (r.type === 'ai-title' && typeof r.aiTitle === 'string' && r.aiTitle) generated = r.aiTitle;
    } catch {
      // A line cut off mid-write.
    }
  }
  return custom ?? generated;
}

/** Codex's session index: one JSON line per rename, the last per thread wins. */
export function codexIndexTitles(text: string): Map<string, string> {
  const titles = new Map<string, string>();
  for (const line of text.split('\n')) {
    try {
      const r = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
      if (typeof r.id === 'string' && typeof r.thread_name === 'string' && r.thread_name) titles.set(r.id, r.thread_name);
    } catch {
      // Blank or cut-off line.
    }
  }
  return titles;
}

/** Titles by client conversation ID from another app's database; `sql` selects `native` and `title`. */
function readDbTitles(file: string, sql: string, client: string): Map<string, string> {
  const titles = new Map<string, string>();
  if (!existsSync(file)) return titles;
  try {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      for (const r of db.prepare(sql).all() as { native: string; title: string }[]) titles.set(r.native, r.title);
    } finally {
      db.close();
    }
  } catch (err) {
    // Clients may change their schema; names are optional.
    console.warn(`[conversations] ${client} titles unreadable:`, err instanceof Error ? err.message : err);
  }
  return titles;
}

/** Names for proxy session IDs from the clients' own records: T3 Code thread titles, then Codex (index, then database) and Claude Code. */
class ConversationNames {
  private titles = new Map<string, string>();
  private titlesReadAt = 0;
  /** Claude Code transcript titles by file, valid while the file's mtime holds. */
  private transcripts = new Map<string, { mtimeMs: number; title: string | null }>();

  async names(sessionIds: unknown): Promise<Record<string, string>> {
    if (!Array.isArray(sessionIds)) return {};
    const ids = sessionIds.filter((x): x is string => typeof x === 'string').slice(0, MAX_IDS_PER_CALL);
    await this.refreshTitles();
    const out: Record<string, string> = {};
    for (const sessionId of ids) {
      const native = nativeConversationId(sessionId);
      if (!native) continue;
      const title = this.titles.get(native.id) ?? (native.client === 'claude' ? await this.claudeTitle(native.id) : null);
      if (title) out[sessionId] = title;
    }
    return out;
  }

  private async refreshTitles(): Promise<void> {
    if (Date.now() - this.titlesReadAt < TITLE_LIST_REFRESH_MS) return;
    this.titlesReadAt = Date.now();
    const codexHome = clientHomes().codex;
    const index = path.join(codexHome, 'session_index.jsonl');
    const renamed = existsSync(index) ? codexIndexTitles(await readFile(index, 'utf8').catch(() => '')) : new Map<string, string>();
    const codex = readDbTitles(path.join(codexHome, CODEX_STATE_DB_NAME), CODEX_TITLES_SQL, 'Codex');
    // Later sources win: renames over Codex's titles, and T3 Code titles, which the user sees, over both.
    this.titles = new Map([...codex, ...renamed, ...readDbTitles(T3_STATE_DB, T3_TITLES_SQL, 'T3 Code')]);
  }

  private async claudeTitle(sessionUuid: string): Promise<string | null> {
    if (!CLAUDE_SESSION_UUID.test(sessionUuid)) return null;
    const projects = path.join(clientHomes().claude, 'projects');
    if (!existsSync(projects)) return null;
    for (const dir of readdirSync(projects)) {
      const file = path.join(projects, dir, `${sessionUuid}.jsonl`);
      const info = await stat(file).catch(() => null);
      if (!info) continue;
      const cached = this.transcripts.get(file);
      if (cached?.mtimeMs === info.mtimeMs) return cached.title;
      const title = claudeTranscriptTitle(await readFile(file, 'utf8').catch(() => ''));
      this.transcripts.set(file, { mtimeMs: info.mtimeMs, title });
      return title;
    }
    return null;
  }
}

export const conversationNames = new ConversationNames();
