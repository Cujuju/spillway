/**
 * Text edits that point Claude Code (settings.json) and Codex (config.toml) at the proxy, and undo them.
 * Pure string in, string out; the file handling is in clientSetup.ts.
 */
import type { ClientSetupState } from '@shared/types';
import { APP_NAME } from '@shared/app';
import {
  CLAUDE_BASE_URL_VAR, CLAUDE_HEADERS_VAR, CLAUDE_KEY_HEADER, CLAUDE_TOKEN_VAR, claudeKeyHeader,
} from '@shared/claudeEnv';

export interface ClientTarget {
  /** e.g. http://127.0.0.1:8317 */
  endpoint: string;
  key: string;
}

const CRLF = '\r\n';
const BOM = '﻿';
const eolOf = (text: string) => (text.includes(CRLF) ? CRLF : '\n');

// ── Claude Code: settings.json "env" ─────────────────────────────

/** Every variable setup touches; undo restores each. */
const CLAUDE_VARS = [CLAUDE_BASE_URL_VAR, CLAUDE_HEADERS_VAR, CLAUDE_TOKEN_VAR] as const;
/** Claude Code writes settings.json with two-space indentation. */
const JSON_INDENT = 2;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Empty or missing text is an empty object; anything else must be a JSON object with an object "env". */
function parseSettings(text: string | null): Json {
  const body = (text ?? '').replace(BOM, '');
  if (body.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('settings.json is not valid JSON; fix it, then try again');
  }
  if (!isObject(parsed)) throw new Error('settings.json is not a JSON object');
  if (parsed.env !== undefined && !isObject(parsed.env)) throw new Error('settings.json "env" is not an object');
  return parsed;
}

/** Keeps the original's BOM, line endings and trailing newline. */
function formatSettings(value: Json, original: string | null): string {
  const text = original ?? '';
  const eol = eolOf(text);
  const trailing = text.trim() === '' || /\n$/.test(text) ? eol : '';
  // JSON.stringify escapes newlines inside strings, so every raw \n is a line break.
  const body = JSON.stringify(value, null, JSON_INDENT).replace(/\n/g, eol);
  return `${text.startsWith(BOM) ? BOM : ''}${body}${trailing}`;
}

const envOf = (settings: Json): Json => (isObject(settings.env) ? settings.env : {});

/** ANTHROPIC_CUSTOM_HEADERS holds one "Name: value" per line. */
const headerLines = (value: unknown) => (typeof value === 'string' ? value.split(/\r?\n/).filter((line) => line.trim() !== '') : []);
const isKeyHeader = (line: string) => (line.split(':', 1)[0] ?? '').trim().toLowerCase() === CLAUDE_KEY_HEADER.toLowerCase();

/** Replaces any key header line and keeps the user's other headers. */
const withKeyHeader = (value: unknown, key: string) =>
  [...headerLines(value).filter((line) => !isKeyHeader(line)), claudeKeyHeader(key)].join('\n');

export function applyClaude(text: string | null, target: ClientTarget): string {
  const settings = parseSettings(text);
  const env = envOf(settings);
  const next: Json = { ...env, [CLAUDE_BASE_URL_VAR]: target.endpoint, [CLAUDE_HEADERS_VAR]: withKeyHeader(env[CLAUDE_HEADERS_VAR], target.key) };
  delete next[CLAUDE_TOKEN_VAR];
  // Assigning an existing "env" keeps its position; a new one goes last.
  settings.env = next;
  return formatSettings(settings, text);
}

/** Restores only the setup's variables to their backed-up values; later edits to anything else stay. */
export function undoClaude(text: string, backup: string | null): string {
  const settings = parseSettings(text);
  const saved = parseSettings(backup);
  const env = { ...envOf(settings) };
  for (const name of CLAUDE_VARS) {
    const old = envOf(saved)[name];
    if (old === undefined) delete env[name];
    else env[name] = old;
  }
  if (Object.keys(env).length === 0 && saved.env === undefined) delete settings.env;
  else settings.env = env;
  return formatSettings(settings, text);
}

/** `applied` means a backup exists, i.e. the app applied it and has not undone it. */
export function claudeState(text: string | null, target: ClientTarget, applied: boolean): ClientSetupState {
  // Parsed even when not applied, so a broken file shows before Apply.
  const env = envOf(parseSettings(text));
  if (!applied) return 'not-applied';
  const current = env[CLAUDE_BASE_URL_VAR] === target.endpoint
    && headerLines(env[CLAUDE_HEADERS_VAR]).includes(claudeKeyHeader(target.key))
    && env[CLAUDE_TOKEN_VAR] === undefined;
  return current ? 'applied' : 'out-of-date';
}

/** True when settings.json holds nothing, so undoing a created file can delete it. */
export const claudeIsEmpty = (text: string) => Object.keys(parseSettings(text)).length === 0;

// ── Codex: config.toml root keys ─────────────────────────────────
// Text-level edit, no TOML parser. Residual: a multi-line string holding a line that starts with `[`
// or one of the root keys below can be mistaken for a table header or a root key.

const BLOCK_TAG = '# >>> spillway';
const BLOCK_BEGIN = `${BLOCK_TAG}: added by ${APP_NAME}; remove it with Undo in the app`;
const BLOCK_END = '# <<< spillway';
/** Prefix for a root line setting a key the apply owns, turned off by the apply; undo removes it. */
export const DISABLED_PREFIX = '# spillway disabled: ';
/**
 * Codex's built-in OpenAI provider posts model, image and compaction calls under openai_base_url. Keeping that
 * provider (not a custom one) keeps every feature Codex gates on it, such as the image tool.
 */
const CODEX_API_PATH = '/backend-api/codex';
/** Codex sends ChatGPT account calls (usage, plan, plugins) under chatgpt_base_url; the proxy answers as the pool. */
const BACKEND_PATH = '/backend-api/';
/** Codex must read the pool login from auth.json, not a keyring login. */
const AUTH_STORE = 'file';

const TABLE_HEADER = /^\s*\[/;
/** Root keys the apply sets, plus model_provider: any provider but the built-in one would bypass the proxy. */
const ROOT_OWNED_KEY = /^\s*(model_provider|openai_base_url|chatgpt_base_url|cli_auth_credentials_store)\s*=/;

/** TOML basic strings accept JSON's string escapes. */
const tomlString = (s: string) => JSON.stringify(s);

const splitLines = (text: string): string[] => {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
};
const joinLines = (lines: string[], eol: string) => (lines.length ? `${lines.join(eol)}${eol}` : '');

/** Splits text into lines outside the app's blocks and the lines inside them. */
function partition(text: string): { outside: string[]; blocks: string[][] } {
  const outside: string[] = [];
  const blocks: string[][] = [];
  let block: string[] | null = null;
  for (const line of splitLines(text)) {
    const trimmed = line.trim();
    if (block) {
      if (trimmed === BLOCK_END) {
        blocks.push(block);
        block = null;
      } else block.push(line);
    } else if (trimmed.startsWith(BLOCK_TAG)) block = [];
    else outside.push(line);
  }
  if (block) throw new Error(`config.toml has "${BLOCK_TAG}" without "${BLOCK_END}"; fix it, then try again`);
  return { outside, blocks };
}

/** Index of the first table header; root keys must come before it. */
const firstTable = (lines: string[]) => {
  const i = lines.findIndex((l) => TABLE_HEADER.test(l));
  return i === -1 ? lines.length : i;
};

/** The root block's lines, without its markers. */
const codexRootBlock = (target: ClientTarget): string[] => [
  `openai_base_url = ${tomlString(`${target.endpoint}${CODEX_API_PATH}`)}`,
  `chatgpt_base_url = ${tomlString(`${target.endpoint}${BACKEND_PATH}`)}`,
  `cli_auth_credentials_store = ${tomlString(AUTH_STORE)}`,
];

export function applyCodex(text: string | null, target: ClientTarget): string {
  const original = text ?? '';
  // Dropping every earlier block also removes an older apply's provider table.
  const { outside } = partition(original);
  const rootEnd = firstTable(outside);
  const body = outside.map((l, i) => (i < rootEnd && ROOT_OWNED_KEY.test(l) ? `${DISABLED_PREFIX}${l}` : l));
  // Root keys first: everything after a table header belongs to that table.
  return joinLines([BLOCK_BEGIN, ...codexRootBlock(target), BLOCK_END, ...body], eolOf(original));
}

export function undoCodex(text: string): string {
  const { outside } = partition(text);
  return joinLines(outside.map((l) => (l.startsWith(DISABLED_PREFIX) ? l.slice(DISABLED_PREFIX.length) : l)), eolOf(text));
}

/** Applied only when the blocks match what apply would write now, so any changed field shows as out of date. */
export function codexState(text: string | null, target: ClientTarget): ClientSetupState {
  const { outside, blocks } = partition(text ?? '');
  if (blocks.length === 0) return 'not-applied';
  const current =
    JSON.stringify(blocks) === JSON.stringify([codexRootBlock(target)]) &&
    // A root key of ours added since would clash (duplicate key).
    !outside.slice(0, firstTable(outside)).some((l) => ROOT_OWNED_KEY.test(l));
  return current ? 'applied' : 'out-of-date';
}

export const codexIsEmpty = (text: string) => text.trim() === '';
