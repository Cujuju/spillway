import type { CaptureFrame } from './archive';

function stringsIn(value: unknown): string[] {
  const result: string[] = [], stack: unknown[] = [value];
  let nodes = 0;
  while (stack.length && nodes++ < 100_000) {
    const item = stack.pop();
    if (typeof item === 'string') result.push(item);
    else if (Array.isArray(item)) stack.push(...item.slice(0, 10_000).toReversed());
    else if (item && typeof item === 'object') stack.push(...Object.values(item).slice(0, 10_000).toReversed());
  }
  return result;
}
function deltaText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const r = value as Record<string, unknown>;
  if (typeof r.delta === 'string') return r.delta;
  if (r.delta && typeof r.delta === 'object') {
    const delta = r.delta as Record<string, unknown>;
    if (typeof delta.text === 'string') return delta.text;
    if (typeof delta.content === 'string') return delta.content;
    if (typeof delta.partial_json === 'string') return delta.partial_json;
  }
  if (Array.isArray(r.choices)) return r.choices.map(deltaText).join('');
  return '';
}
function packets(text: string): unknown[] {
  try { return [JSON.parse(text)]; }
  catch { /* HTTP event streams contain one JSON payload per data block. */ }
  const result: unknown[] = [];
  for (const block of text.split(/\r?\n\r?\n/).slice(0, 10_000)) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') continue;
    try { result.push(JSON.parse(data)); }
    catch { /* Partial/truncated packets remain searchable as their raw prefix. */ }
  }
  return result;
}
/** Decodes JSON escapes and joins streamed text deltas without changing saved protocol text. */
export function archiveSearchText(request: string, response: string, frames: CaptureFrame[] = []): string {
  const messages = frames.length ? frames.map((f) => f.payload) : [request, response];
  const values = messages.flatMap(packets);
  return [...messages, ...values.flatMap(stringsIn), values.map(deltaText).join('')].join('\n').slice(0, 4 * 1024 * 1024);
}
export function readableStreamText(text: string, frames: CaptureFrame[] = []): string {
  const values = frames.length ? frames.flatMap((f) => packets(f.payload)) : packets(text);
  return values.map(deltaText).join('');
}
