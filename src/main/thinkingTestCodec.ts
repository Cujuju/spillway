import { isDeepStrictEqual } from 'node:util';
import type { ThinkingSetting } from '@shared/thinking';
import { object } from './evalCaseCodec';

// Mirrors internal/thinking/convert.go; manual Claude budgets use the fork's level conversion.
const CLAUDE_BUDGETS: Record<string, number> = { none: 0, minimal: 512, low: 1024, medium: 8192, high: 24576, xhigh: 32768, max: 128000 };
// Anthropic requires streaming above this output allowance.
const CLAUDE_NONSTREAM_TOKENS = 21333;
export const TEST_ROUTES = ['/v1/messages', '/v1/chat/completions', '/v1/responses', '/backend-api/codex/responses'];
export interface NextMove { text: string; tools: { name: string; input: unknown }[] }
export function rewriteTestBody(raw: Record<string, unknown>, route: string, setting: ThinkingSetting): Record<string, unknown> {
  const body = structuredClone(raw); body.model = setting.model; body.stream = false;
  if (route === '/v1/messages') {
    if (object(body.output_config) && 'effort' in body.output_config || !object(body.thinking) || body.thinking.type === 'adaptive') {
      body.output_config = { ...(object(body.output_config) ? body.output_config : {}), effort: setting.effort };
      body.thinking = setting.effort === 'none' ? { type: 'disabled' } : { ...(object(body.thinking) ? body.thinking : {}), type: 'adaptive' };
      delete (body.thinking as Record<string, unknown>).budget_tokens;
      if (setting.effort === 'none') delete (body.output_config as Record<string, unknown>).effort;
    } else {
      const budget = CLAUDE_BUDGETS[setting.effort];
      if (budget === undefined) throw new Error('Unsupported Claude thinking effort');
      body.thinking = budget ? { type: 'enabled', budget_tokens: budget } : { type: 'disabled' };
    }
    body.stream = typeof body.max_tokens === 'number' && body.max_tokens > CLAUDE_NONSTREAM_TOKENS;
  } else {
    if (route === '/v1/chat/completions' || 'reasoning_effort' in body) body.reasoning_effort = setting.effort;
    else body.reasoning = { ...(object(body.reasoning) ? body.reasoning : {}), effort: setting.effort };
  }
  return body;
}
export function assembleResponse(raw: string): Record<string, any> {
  if (raw.trimStart().startsWith('{')) {
    const data: unknown = JSON.parse(raw); if (!object(data) || data.error) throw new Error('Malformed model response'); return data;
  }
  let message: Record<string, any> = {}, complete = false;
  const blocks: Record<string, any>[] = [], calls: Record<string, any>[] = [];
  for (const frame of raw.replaceAll('\r\n', '\n').split('\n\n')) {
    const text = frame.split('\n').filter((s) => s.startsWith('data:')).map((s) => s.slice(5).trimStart()).join('\n');
    if (!text || text === '[DONE]') continue;
    const e = JSON.parse(text);
    if (e.error || e.type === 'error' || e.type === 'response.failed') throw new Error('Stream failed');
    if (e.type === 'response.completed') { message = e.response; complete = true; }
    if (e.type === 'message_start') message = e.message;
    if (e.type === 'content_block_start') blocks[e.index] = { ...e.content_block, arguments: '' };
    if (e.type === 'content_block_delta') {
      const b = blocks[e.index]; if (!b) throw new Error('Incomplete content block');
      if (e.delta.type === 'text_delta') b.text = (b.text ?? '') + e.delta.text;
      if (e.delta.type === 'input_json_delta') b.arguments += e.delta.partial_json;
    }
    if (e.type === 'message_delta') { Object.assign(message, e.delta); message.usage = { ...message.usage, ...e.usage }; }
    if (e.type === 'message_stop') { message.content = blocks.map((b) => b.type === 'tool_use' && b.arguments ? { ...b, input: JSON.parse(b.arguments) } : b); complete = true; }
    if (e.usage) message.usage = { ...message.usage, ...e.usage };
    const c = e.choices?.[0];
    if (c) {
      message.text = (message.text ?? '') + (c.delta?.content ?? '');
      for (const t of c.delta?.tool_calls ?? []) { const own = calls[t.index] ??= { name: '', arguments: '' }; own.name += t.function?.name ?? ''; own.arguments += t.function?.arguments ?? ''; }
      if (c.finish_reason) { message.choices = [{ finish_reason: c.finish_reason, message: { content: message.text, tool_calls: calls.map((t) => ({ function: t })) } }]; complete = true; }
    }
  }
  if (!complete) throw new Error('Incomplete response stream'); return message;
}
export function nextMove(data: Record<string, any>): NextMove {
  if (data.error || data.status === 'incomplete' || data.status === 'failed' || data.stop_reason === 'max_tokens') throw new Error('Incomplete model response');
  const result: NextMove = { text: '', tools: [] };
  if (Array.isArray(data.content)) for (const b of data.content) {
    if (b.type === 'text') result.text += b.text;
    if (b.type === 'tool_use') result.tools.push({ name: b.name, input: b.input });
  }
  for (const b of data.output ?? []) {
    if (b.type === 'message') for (const t of b.content ?? []) if (t.type === 'output_text') result.text += t.text;
    if (b.type === 'function_call') result.tools.push({ name: b.name, input: JSON.parse(b.arguments) });
    if (b.type === 'custom_tool_call') result.tools.push({ name: b.name, input: b.input });
  }
  const c = data.choices?.[0];
  if (c) {
    if (c.finish_reason && !['stop', 'tool_calls', 'function_call'].includes(c.finish_reason)) throw new Error('Incomplete chat response');
    result.text += c.message?.content ?? '';
    for (const t of c.message?.tool_calls ?? []) result.tools.push({ name: t.function.name, input: JSON.parse(t.function.arguments) });
    if (c.message?.function_call) result.tools.push({ name: c.message.function_call.name, input: JSON.parse(c.message.function_call.arguments) });
  }
  if (result.tools.some((t) => typeof t.name !== 'string' || !t.name || t.input === undefined)) throw new Error('Malformed tool call');
  if (!result.text && !result.tools.length) throw new Error('Response has no next move');
  return result;
}
export const exactTools = (a: NextMove, b: NextMove) => a.tools.length > 0 && b.tools.length > 0 && isDeepStrictEqual(a.tools, b.tools);
export function parseJudge(text: string): { outcome: 'match' | 'differ'; reason: string } {
  const v: unknown = JSON.parse(text);
  if (!object(v) || !['match', 'differ'].includes(v.verdict as string) || typeof v.reason !== 'string' || !v.reason.trim() || Object.keys(v).sort().join() !== 'reason,verdict') throw new Error('Malformed judge output');
  return { outcome: v.verdict as 'match' | 'differ', reason: v.reason };
}
