import type { ArchiveDetail, CaptureCut, CaptureFrame } from './archive';
import { readableStreamText } from './archiveContent';

export type ExchangePart =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool-call'; name: string; text: string }
  | { kind: 'tool-result'; name: string; text: string }
  | { kind: 'media'; text: string }
  | { kind: 'gap'; text: string };
/** `role` is '' for a gap between recorded WebSocket messages. */
export interface ExchangeMessage { role: string; parts: ExchangePart[] }
export interface ExchangeSide {
  /** HTTP body as stored; WebSocket payloads in direction order, joined by two newlines. */
  raw: string;
  /** Strict JSON, formatted with two spaces. */
  pretty: string | null;
  /** Recognised messages before any gap, including a recoverable cut end. */
  messages: ExchangeMessage[] | null;
  /** Where recording stopped or left out bytes before `tail`; null when nothing is missing at that point. */
  cut: ExchangeGap | null;
  /** WebSocket losses between recorded messages, each a gap message in `messages`. */
  gaps: number;
  /** Raw text recorded after the gap (head + tail capture); '' when nothing follows it. */
  tail: string;
}
/** `at` indexes `raw`; `omitted` is bytes left out, null when unknown. */
export interface ExchangeGap { at: number; omitted: number | null }

const BASE64_WIRE_PREFIX = 'Base64 wire body:\n';
/** Head-only per-side cap of proxies before per-side cuts (#134); rows stored then carry no cut fields. */
export const LEGACY_CAPTURE_BODY_LIMIT = 256 * 1024;
const WEBSOCKET_LIMIT_REASONS = new Set(['websocket-frame-count-limit', 'websocket-byte-limit', 'websocket-frame-or-byte-limit']);
const encoder = new TextEncoder();
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const string = (value: unknown): string => typeof value === 'string' ? value : '';

/** Reads each token once; unfinished values never replace their preceding siblings. */
function prefixJSON(raw: string): unknown {
  type Container = { value: Record<string, unknown> | unknown[]; state: 'key' | 'colon' | 'value' | 'comma'; key: string };
  const stack: Container[] = [];
  let root: unknown, index = 0;
  const put = (value: unknown) => {
    const parent = stack.at(-1);
    if (!parent) root = value;
    else {
      if (Array.isArray(parent.value)) parent.value.push(value);
      else Object.defineProperty(parent.value, parent.key, { value, enumerable: true, configurable: true, writable: true });
      parent.state = 'comma';
    }
  };
  const readString = () => {
    const start = index++;
    let closed = false;
    while (index < raw.length) {
      const char = raw[index]!;
      if (char === '"') { index++; closed = true; break; }
      if (char < ' ') break;
      if (char === '\\') {
        const escape = raw[index + 1];
        if (escape === 'u') {
          if (!/^[\da-f]{4}$/i.test(raw.slice(index + 2, index + 6))) break;
          index += 6;
        } else if (escape && /["\\/bfnrt]/.test(escape)) index += 2;
        else break;
      } else index++;
    }
    const token = raw.slice(start, index) + (closed ? '' : '"');
    if (!closed) index = raw.length;
    return { value: JSON.parse(token) as string, closed };
  };
  while (index < raw.length) {
    const char = raw[index]!;
    if (/\s/.test(char)) { index++; continue; }
    const parent = stack.at(-1);
    if (!parent && root !== undefined) break;
    if (parent?.state === 'colon') {
      if (char !== ':') break;
      parent.state = 'value'; index++; continue;
    }
    if (parent && ((Array.isArray(parent.value) && char === ']') || (!Array.isArray(parent.value) && char === '}'))) {
      stack.pop(); index++; continue;
    }
    if (parent?.state === 'comma') {
      if (char !== ',') break;
      parent.state = Array.isArray(parent.value) ? 'value' : 'key'; index++; continue;
    }
    if (parent?.state === 'key') {
      if (char !== '"') break;
      const key = readString();
      if (!key.closed) break;
      parent.key = key.value; parent.state = 'colon'; continue;
    }
    if (char === '{' || char === '[') {
      const value = char === '[' ? [] : {};
      put(value); stack.push({ value, state: char === '[' ? 'value' : 'key', key: '' }); index++; continue;
    }
    if (char === '"') { put(readString().value); continue; }
    const start = index;
    while (index < raw.length && !/[\s,\]}]/.test(raw[index]!)) index++;
    const token = raw.slice(start, index);
    if (!/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(token)) break;
    put(JSON.parse(token));
  }
  return root;
}

function parsed(raw: string): { value: unknown; pretty: string | null } {
  try {
    const value: unknown = JSON.parse(raw);
    return { value, pretty: JSON.stringify(value, null, 2) };
  } catch { return { value: prefixJSON(raw), pretty: null }; }
}
function jsonText(value: unknown): string {
  if (typeof value === 'string') {
    try { return JSON.stringify(JSON.parse(value), null, 2); }
    catch { return value; }
  }
  return JSON.stringify(value, null, 2) ?? '';
}

function messagesIn(values: unknown[]): ExchangeMessage[] | null {
  const messages: ExchangeMessage[] = [], names = new Map<string, string>();
  const call = (name: unknown, input: unknown, id?: unknown): ExchangePart => {
    if (string(id) && string(name)) names.set(string(id), string(name));
    return { kind: 'tool-call', name: string(name), text: jsonText(input) };
  };
  const resultText = (value: unknown): string => Array.isArray(value) ? parts(value).map((part) => part.text).join('\n') : typeof value === 'string' ? value : jsonText(value);
  const result = (name: unknown, value: unknown): ExchangePart => ({ kind: 'tool-result', name: string(name), text: resultText(value) });
  const parts = (value: unknown): ExchangePart[] => {
    if (typeof value === 'string') return value ? [{ kind: 'text', text: value }] : [];
    return list(value).flatMap((item): ExchangePart[] => {
      const block = record(item), type = string(block.type);
      if (block.thought === true && typeof block.text === 'string') return block.text ? [{ kind: 'thinking', text: block.text }] : [];
      if (['text', 'input_text', 'output_text'].includes(type) || (!type && typeof block.text === 'string')) return string(block.text) ? [{ kind: 'text', text: string(block.text) }] : [];
      if (type === 'thinking' || type === 'redacted_thinking') {
        const text = string(block.thinking) || string(block.text) || (type === 'redacted_thinking' ? 'Redacted thinking' : '');
        return text ? [{ kind: 'thinking', text }] : [];
      }
      if (type === 'tool_use') return [call(block.name, block.input, block.id)];
      if (type === 'tool_result') return [result(block.tool_use_id, block.content)];
      if (type === 'input_file') return [{ kind: 'media', text: string(block.filename) || string(block.mime_type) || /^data:([^;,]+)/.exec(string(block.file_data))?.[1] || 'file' }];
      if (['image', 'document', 'image_url', 'input_image'].includes(type)) {
        const url = string(block.image_url) || string(record(block.image_url).url);
        return [{ kind: 'media', text: string(record(block.source).media_type) || /^data:([^;,]+)/.exec(url)?.[1] || (type === 'document' ? 'document' : 'image') }];
      }
      if (!type && block.functionCall) { const fn = record(block.functionCall); return [call(fn.name, fn.args)]; }
      if (!type && block.functionResponse) { const fn = record(block.functionResponse); return [result(fn.name, fn.response)]; }
      if (!type && (block.inlineData || block.fileData)) return [{ kind: 'media', text: string(record(block.inlineData || block.fileData).mimeType) || 'media' }];
      return [];
    });
  };
  const add = (role: string, content: ExchangePart[]) => { if (content.length) messages.push({ role, parts: content }); };
  const message = (value: unknown, fallback: string) => {
    if (typeof value === 'string') { add(fallback, parts(value)); return; }
    const item = record(value), role = string(item.role) || fallback;
    if (item.type === 'function_call') { add('assistant', [call(item.name, item.arguments, item.call_id || item.id)]); return; }
    if (item.type === 'custom_tool_call') { add('assistant', [call(item.name, item.input, item.call_id || item.id)]); return; }
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') { add('tool', [result(item.call_id, item.output)]); return; }
    if (item.type === 'reasoning') {
      const text = list(item.summary).map((entry) => string(record(entry).text)).filter(Boolean).join('\n');
      if (text) add('assistant', [{ kind: 'thinking', text }]);
      return;
    }
    if (item.type && item.type !== 'message') return;
    if (role === 'tool') { add(role, [result(item.name || item.tool_call_id, item.content)]); return; }
    const content = parts(item.content ?? item.parts);
    if (string(item.reasoning_content)) content.unshift({ kind: 'thinking', text: string(item.reasoning_content) });
    for (const entry of list(item.tool_calls)) {
      const tool = record(entry), fn = record(tool.function);
      content.push(call(fn.name, fn.arguments, tool.id));
    }
    add(role, content);
  };
  for (const value of values) {
    const envelope = record(value);
    const body = envelope.type === 'response.create' && envelope.response ? record(envelope.response) : envelope;
    add('system', parts(body.system));
    add('system', parts(body.instructions));
    add('system', parts(record(body.systemInstruction).parts));
    for (const item of list(body.messages)) message(item, 'user');
    if (typeof body.input === 'string') message(body.input, 'user');
    else for (const item of list(body.input)) message(item, 'user');
    for (const item of list(body.contents)) message(item, 'user');
    for (const choice of list(body.choices)) message(record(choice).message, 'assistant');
    for (const item of list(body.output)) message(item, 'assistant');
    for (const candidate of list(body.candidates)) message(record(candidate).content, 'assistant');
    if (body.content) message(body, 'assistant');
  }
  for (const message of messages) for (const part of message.parts) {
    if (part.kind === 'tool-result') part.name = names.get(part.name) ?? part.name;
  }
  return messages.length ? messages : null;
}

function bodyBytes(raw: string): number {
  if (!raw.startsWith(BASE64_WIRE_PREFIX)) return encoder.encode(raw).length;
  const base64 = raw.slice(BASE64_WIRE_PREFIX.length);
  return Math.floor(base64.length * 3 / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
}

/** UTF-16 index of a UTF-8 byte offset; offsets inside a character round down. */
function charIndex(text: string, bytes: number): number {
  let index = 0, used = 0;
  while (index < text.length) {
    const point = text.codePointAt(index)!;
    used += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    if (used > bytes) break;
    index += point > 0xffff ? 2 : 1;
  }
  return index;
}
/** Text before a frame's cut; the tail after it can't be read as JSON. */
const headOf = (payload: string, cut: CaptureCut | undefined) => cut ? payload.slice(0, charIndex(payload, cut.offset)) : payload;

/** One direction's frames, split after a cut frame or where frame indexes were dropped. A drop in either direction splits both. */
function frameRuns(all: CaptureFrame[], direction: CaptureFrame['direction']): { runs: CaptureFrame[][]; endLost: boolean } {
  const runs: CaptureFrame[][] = [];
  const lostAfter = (prior: number, at: number) => all[prior]!.truncated || all[at]!.index - all[prior]!.index > at - prior;
  let prior = -1;
  all.forEach((frame, at) => {
    if (frame.direction !== direction) return;
    if (prior < 0 || lostAfter(prior, at)) runs.push([]);
    runs.at(-1)!.push(frame); prior = at;
  });
  return { runs, endLost: prior >= 0 && lostAfter(prior, all.length - 1) };
}
const GAP_MESSAGE: ExchangeMessage = { role: '', parts: [{ kind: 'gap', text: 'Messages not recorded here.' }] };

/** The detail fields exchangeSide reads. */
export type ExchangeInput = Pick<ArchiveDetail, 'request' | 'response' | 'frames' | 'format' | 'reason' | 'requestCut' | 'responseCut'>;
/** Copies exactly the ExchangeInput fields, so a caller sending a detail elsewhere (the parse worker) can't drop one. */
export const exchangeInput = ({ request, response, frames, format, reason, requestCut, responseCut }: ExchangeInput): ExchangeInput =>
  ({ request, response, frames, format, reason, requestCut, responseCut });
export function exchangeSide(detail: ExchangeInput, direction: 'request' | 'response'): ExchangeSide {
  const legacy = detail.requestCut === undefined && detail.responseCut === undefined;
  if (detail.format === 'websocket') {
    const { runs, endLost } = frameRuns(detail.frames, direction);
    const frames = runs.flat();
    const raw = frames.map((frame) => frame.payload).join('\n\n');
    // Each run reads alone, through cut frames' heads, so text never joins across a loss.
    const readable = runs.map((run) => {
      const heads = run.map((frame) => ({ ...frame, payload: headOf(frame.payload, frame.cut) }));
      const streamed = direction === 'response' ? readableStreamText('', heads) : '';
      return streamed ? [{ role: 'assistant', parts: [{ kind: 'text', text: streamed }] } satisfies ExchangeMessage] : messagesIn(heads.map((frame) => parsed(frame.payload).value)) ?? [];
    });
    const messages = readable.flatMap((run, i) => i ? [GAP_MESSAGE, ...run] : run);
    const legacyCut = legacy && (WEBSOCKET_LIMIT_REASONS.has(detail.reason) || frames.reduce((bytes, frame) => bytes + encoder.encode(frame.payload).length, 0) >= LEGACY_CAPTURE_BODY_LIMIT);
    const cut = endLost || legacyCut;
    return { raw, pretty: frames.length === 1 && !cut ? parsed(raw).pretty : null, tail: '', cut: cut ? { at: raw.length, omitted: null } : null,
      gaps: Math.max(0, runs.length - 1), messages: messages.some((m) => m !== GAP_MESSAGE) ? messages : null };
  }
  const raw = detail[direction], recorded = detail[direction === 'request' ? 'requestCut' : 'responseCut'];
  const cut = recorded ? { at: charIndex(raw, recorded.offset), omitted: recorded.omitted }
    : legacy && bodyBytes(raw) >= LEGACY_CAPTURE_BODY_LIMIT ? { at: raw.length, omitted: null } : null;
  const head = cut ? raw.slice(0, cut.at) : raw;
  const { value, pretty } = parsed(head);
  const streamed = direction === 'response' ? readableStreamText(head) : '';
  return { raw, pretty: cut ? null : pretty, tail: cut ? raw.slice(cut.at) : '', cut, gaps: 0,
    messages: streamed ? [{ role: 'assistant', parts: [{ kind: 'text', text: streamed }] }] : messagesIn([value]) };
}
