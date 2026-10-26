/**
 * Text edits that point Claude Code (settings.json) and Codex (config.toml) at the proxy, and undo them.
 * Pure string in, string out; the file handling is in clientSetup.ts.
 */
import type { ClientSetupState } from '@shared/types';
import { APP_NAME } from '@shared/app';
import {
  CLAUDE_BASE_URL_VAR, CLAUDE_HEADERS_VAR, CLAUDE_KEY_HEADER, CLAUDE_TOKEN_VAR, claudeKeyHeader,
} from '@shared/claudeEnv';

/** A program that prints the client key to stdout. */
export interface KeyCommand {
  command: string;
  args: string[];
}

export interface ClientTarget {
  /** e.g. http://127.0.0.1:8317 */
  endpoint: string;
  key: string;
  /** Codex fetches the key with this instead of storing it. */
  keyCommand: KeyCommand;
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

// ── Codex: config.toml provider ──────────────────────────────────
// Text-level edit, no TOML parser. Residual: a multi-line string holding a line that starts with `[`
// or `model_provider =` can be mistaken for a table header or a root key.

export const CODEX_PROVIDER_ID = 'spillway';
const BLOCK_TAG = '# >>> spillway';
const BLOCK_BEGIN = `${BLOCK_TAG}: added by ${APP_NAME}; remove it with Undo in the app`;
const BLOCK_END = '# <<< spillway';
/** Prefix for a root `model_provider` line the apply turned off; undo removes it. */
export const DISABLED_PREFIX = '# spillway disabled: ';
/** The proxy serves the OpenAI API under /v1; Codex posts to <base_url>/responses. */
const OPENAI_PATH = '/v1';
/** 0: Codex keeps the key until the proxy rejects it, then reruns the command. The key changes only on regenerate. */
const KEY_REFRESH_INTERVAL_MS = 0;
/**
 * Print-key mode measured ~0.4 s warm. A timeout fails the Codex session until restart, so allow far more
 * than Codex's 5 s default for a cold start after boot.
 */
const KEY_COMMAND_TIMEOUT_MS = 15_000;

const TABLE_HEADER = /^\s*\[/;
const ROOT_MODEL_PROVIDER = /^\s*model_provider\s*=/;
const OWN_PROVIDER_ELSEWHERE = new RegExp(
  `^\\s*(\\[\\s*model_providers\\s*\\.\\s*"?${CODEX_PROVIDER_ID}"?\\s*[\\].]|model_providers\\s*\\.\\s*"?${CODEX_PROVIDER_ID}"?\\s*[.=])`,
);

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

/** Lines inside the root block and the provider block, without their markers. */
function codexBlocks(target: ClientTarget): [root: string[], provider: string[]] {
  const { command, args } = target.keyCommand;
  return [
    [`model_provider = ${tomlString(CODEX_PROVIDER_ID)}`],
    [
      `[model_providers.${CODEX_PROVIDER_ID}]`,
      `name = ${tomlString(APP_NAME)}`,
      `base_url = ${tomlString(`${target.endpoint}${OPENAI_PATH}`)}`,
      `wire_api = ${tomlString('responses')}`,
      // Codex runs this for the key, so the key itself is never written here.
      `[model_providers.${CODEX_PROVIDER_ID}.auth]`,
      `command = ${tomlString(command)}`,
      `args = [${args.map(tomlString).join(', ')}]`,
      `refresh_interval_ms = ${KEY_REFRESH_INTERVAL_MS}`,
      `timeout_ms = ${KEY_COMMAND_TIMEOUT_MS}`,
    ],
  ];
}

export function applyCodex(text: string | null, target: ClientTarget): string {
  const original = text ?? '';
  const { outside } = partition(original);
  if (outside.some((l) => OWN_PROVIDER_ELSEWHERE.test(l))) {
    throw new Error(`config.toml already defines model_providers.${CODEX_PROVIDER_ID}; rename or remove it, then try again`);
  }
  const rootEnd = firstTable(outside);
  const body = outside.map((l, i) => (i < rootEnd && ROOT_MODEL_PROVIDER.test(l) ? `${DISABLED_PREFIX}${l}` : l));
  const [root, provider] = codexBlocks(target);
  const wrap = (lines: string[]) => [BLOCK_BEGIN, ...lines, BLOCK_END];
  // Root key first: everything after a table header belongs to that table.
  return joinLines([...wrap(root), ...body, ...wrap(provider)], eolOf(original));
}

export function undoCodex(text: string): string {
  const { outside } = partition(text);
  return joinLines(outside.map((l) => (l.startsWith(DISABLED_PREFIX) ? l.slice(DISABLED_PREFIX.length) : l)), eolOf(text));
}

/** Applied only when both blocks match what apply would write now, so any changed field shows as out of date. */
export function codexState(text: string | null, target: ClientTarget): ClientSetupState {
  const { outside, blocks } = partition(text ?? '');
  if (blocks.length === 0) return 'not-applied';
  const current =
    JSON.stringify(blocks) === JSON.stringify(codexBlocks(target)) &&
    // A root model_provider added since would clash with ours (duplicate key).
    !outside.slice(0, firstTable(outside)).some((l) => ROOT_MODEL_PROVIDER.test(l));
  return current ? 'applied' : 'out-of-date';
}

export const codexIsEmpty = (text: string) => text.trim() === '';
