import { CAPTURE_BODY_LIMIT, type ArchiveDetail } from './archive';
import { readableStreamText } from './archiveContent';

export type ExchangePart =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool-call'; name: string; text: string }
  | { kind: 'tool-result'; name: string; text: string }
  | { kind: 'media'; text: string };
export interface ExchangeMessage { role: string; parts: ExchangePart[] }
export interface ExchangeSide {
  /** HTTP body as stored; WebSocket payloads in direction order, joined by two newlines. */
  raw: string;
  /** Strict JSON, formatted with two spaces. */
  pretty: string | null;
  /** Recognised messages, including a recoverable cut tail. */
  messages: ExchangeMessage[] | null;
  cut: boolean;
}

const BASE64_WIRE_PREFIX = 'Base64 wire body:\n';
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

export function exchangeSide(detail: Pick<ArchiveDetail, 'request' | 'response' | 'frames' | 'format' | 'reason'>, direction: 'request' | 'response'): ExchangeSide {
  const websocket = detail.format === 'websocket';
  const frames = websocket ? detail.frames.filter((frame) => frame.direction === direction) : [];
  const raw = websocket ? frames.map((frame) => frame.payload).join('\n\n') : detail[direction];
  const { value, pretty } = parsed(raw);
  const streamed = direction === 'response' ? readableStreamText(raw, frames) : '';
  const messages = streamed ? [{ role: 'assistant', parts: [{ kind: 'text' as const, text: streamed }] }] : messagesIn(frames.length > 1 ? frames.map((frame) => parsed(frame.payload).value) : [value]);
  const cut = websocket ? frames.some((frame) => frame.truncated) || frames.reduce((bytes, frame) => bytes + encoder.encode(frame.payload).length, 0) >= CAPTURE_BODY_LIMIT || detail.reason === 'websocket-frame-count-limit' : bodyBytes(raw) >= CAPTURE_BODY_LIMIT;
  return { raw, pretty, messages, cut };
}
