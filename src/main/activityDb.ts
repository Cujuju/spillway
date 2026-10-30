import Database from 'better-sqlite3-multiple-ciphers';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { withCountsFilled } from '@shared/activityCounts';
import { NO_ACCOUNT_KEY, NO_CLIENT_KEY } from '@shared/activityScope';
import type { ActivityDayTotal, ActivityEvent } from '@shared/types';

export type Db = Database.Database;

/** SQLite3 Multiple Ciphers' ChaCha20-Poly1305 scheme, named so a change of library default can't strand the file. */
const CIPHER = 'chacha20';
/** 32 random bytes as hex (settingsStore.ts); checked because it is spliced into a pragma. */
const HEX_KEY = /^[0-9a-f]{64}$/;
/** Errors meaning the file can't be read with this key; anything else (permissions, locks) is rethrown. */
const UNREADABLE_CODES = new Set(['SQLITE_NOTADB', 'SQLITE_CORRUPT']);
/** WAL mode keeps two companion files beside the database. */
const COMPANION_SUFFIXES = ['', '-wal', '-shm'];
export const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const LEGACY_DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const LEGACY_TOTALS_FILE = 'daily-totals.json';
const LEGACY_IMPORTED = 'legacy-files-imported';

/** A conversation's requests on one model (the proxy binds each model separately); queries must use this exact text to use its index. */
export const CONVERSATION_KEY_SQL = `json_extract(event, '$.sessionId'), json_extract(event, '$.model')`;
/** A request's account key (accountKey in activityScope.ts); queries must use this exact text to use its index. */
export const ACCOUNT_KEY_SQL = `coalesce(json_extract(event, '$.authIndex'), '${NO_ACCOUNT_KEY}')`;
/** A request's client key (clientKey in activityScope.ts); queries must use this exact text to use its index. */
export const CLIENT_KEY_SQL = `coalesce(json_extract(event, '$.client'), '${NO_CLIENT_KEY}')`;

/** Rows are ordered by id, the order Spillway recorded them, which also pages the list. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS requests (id INTEGER PRIMARY KEY, day TEXT NOT NULL, failed INTEGER NOT NULL, event TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS requests_by_day ON requests (day, id);
CREATE INDEX IF NOT EXISTS requests_failed ON requests (id) WHERE failed = 1;
CREATE INDEX IF NOT EXISTS requests_by_account ON requests (${ACCOUNT_KEY_SQL}, day, id);
CREATE INDEX IF NOT EXISTS requests_by_client ON requests (${CLIENT_KEY_SQL}, day, id);
CREATE INDEX IF NOT EXISTS requests_by_conversation ON requests (${CONVERSATION_KEY_SQL}, id);
CREATE TABLE IF NOT EXISTS day_totals (key TEXT PRIMARY KEY, total TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS client_log_checkpoints (path TEXT PRIMARY KEY, state TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS usage_identities (key TEXT PRIMARY KEY, event TEXT NOT NULL, row_id INTEGER NOT NULL, matched INTEGER NOT NULL DEFAULT 0, fallback_key TEXT, upstream_id TEXT, source TEXT);
CREATE INDEX IF NOT EXISTS usage_identity_session ON usage_identities (fallback_key, source, matched);
CREATE INDEX IF NOT EXISTS usage_identity_upstream ON usage_identities (upstream_id, source, matched);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/** Totals stored before clients were recorded have no client, and keep the key they were stored under. */
export const totalKey = (t: Pick<ActivityDayTotal, 'day' | 'provider' | 'authIndex' | 'model' | 'client' | 'source'>) =>
  `${t.day}|${t.provider}|${t.authIndex ?? ''}|${t.model}${t.client === null ? '' : `|${t.client}`}${t.source === 'client-log' ? '|client-log' : ''}`;

function openKeyed(file: string, hexKey: string): Db {
  const db = new Database(file);
  try {
    db.pragma(`cipher='${CIPHER}'`);
    db.pragma(`hexkey='${hexKey}'`);
    // The first read fails with SQLITE_NOTADB when the key doesn't match.
    db.prepare('SELECT count(*) FROM sqlite_master').get();
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/** Opens the encrypted log. A file this key can't read (lost secrets, corruption) is set aside and a new one started. */
export function openActivityDb(file: string, hexKey: string): Db {
  if (!HEX_KEY.test(hexKey)) throw new Error('Activity database key is malformed');
  let db: Db;
  try {
    db = openKeyed(file, hexKey);
  } catch (err) {
    if (!UNREADABLE_CODES.has((err as { code?: string }).code ?? '')) throw err;
    const aside = `${file}.unreadable-${Date.now()}`;
    console.error(`[activity] ${file} unreadable, moved to ${aside}:`, err);
    for (const suffix of COMPANION_SUFFIXES) if (existsSync(file + suffix)) renameSync(file + suffix, aside + suffix);
    db = openKeyed(file, hexKey);
  }
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  db.exec(`UPDATE requests SET event = json_set(event, '$.source', 'proxy', '$.upstreamId', null) WHERE json_extract(event, '$.source') IS NULL;`);
  return db;
}

function readLegacyDay(file: string): ActivityEvent[] {
  return readFileSync(file, 'utf8').split('\n').flatMap((line) => {
    if (!line) return [];
    try {
      const e = JSON.parse(line) as ActivityEvent;
      // Requests saved before cache writes were recorded have none.
      return typeof e?.at === 'string' && typeof e.requestId === 'string' ? [{ ...e, cacheWriteTokens: e.cacheWriteTokens ?? 0 }] : [];
    } catch {
      return [];
    }
  });
}

function readLegacyTotals(file: string): ActivityDayTotal[] {
  if (!existsSync(file)) return [];
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(raw) ? raw.filter((r): r is ActivityDayTotal => typeof r?.day === 'string' && typeof r?.requests === 'number').map(withCountsFilled) : [];
  } catch (err) {
    console.error('[activity] legacy totals unreadable, skipped:', err);
    return [];
  }
}

/**
 * Imports the per-day JSONL files and totals once, then deletes them. The flag commits with the rows,
 * so a failed delete never imports twice; later files are deleted unread.
 */
export function importLegacyFiles(db: Db, dir: string): void {
  if (!existsSync(dir)) return;
  if (!db.prepare('SELECT 1 FROM meta WHERE key = ?').get(LEGACY_IMPORTED)) {
    const insertRequest = db.prepare('INSERT INTO requests (day, failed, event) VALUES (?, ?, ?)');
    const insertTotal = db.prepare('INSERT OR REPLACE INTO day_totals (key, total) VALUES (?, ?)');
    db.transaction(() => {
      const days = readdirSync(dir).flatMap((f) => LEGACY_DAY_FILE.exec(f)?.[1] ?? []).sort();
      for (const day of days) {
        for (const e of readLegacyDay(path.join(dir, `${day}.jsonl`))) insertRequest.run(day, e.failed ? 1 : 0, JSON.stringify(e));
      }
      for (const t of readLegacyTotals(path.join(dir, LEGACY_TOTALS_FILE))) insertTotal.run(totalKey(t), JSON.stringify(t));
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(LEGACY_IMPORTED, new Date().toISOString());
    })();
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.error('[activity] imported legacy files not deleted; retrying next launch:', err);
  }
}
