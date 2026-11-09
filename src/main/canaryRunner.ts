import { randomUUID } from 'node:crypto';
import type { CanaryProbe, CanaryResult, CanaryTarget } from '@shared/canary';
/** Room for max-effort thinking on a short problem. */
export const CANARY_MAX_TOKENS = 16_000;
/** Bound each scheduled call to two minutes. */
export const CANARY_TIMEOUT_MS = 120_000;
export interface CanaryConnection { endpoint: string; clientApiKey: string }
export async function runCanaryProbe(target: CanaryTarget, probe: CanaryProbe, batchId: string, claude: boolean, connection: CanaryConnection, fetcher: typeof fetch = fetch): Promise<CanaryResult> {
  const start = Date.now();
  const result: CanaryResult = { id: randomUUID(), batchId, at: new Date(start).toISOString(), ...target, effectiveModel: null, probeId: probe.id, probeVersion: probe.version, outcome: 'error', answer: null, error: null, outputTokens: null, thinkingTokens: null, latencyMs: null };
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-CPA-Purpose': 'canary' };
    if (claude) { headers['X-Api-Key'] = connection.clientApiKey; headers['anthropic-version'] = '2023-06-01'; headers['anthropic-beta'] = 'thinking-token-count-2026-05-13'; }
    else headers.Authorization = `Bearer ${connection.clientApiKey}`;
    const body = { model: target.model, messages: [{ role: 'user', content: probe.prompt }], ...(claude ? { max_tokens: CANARY_MAX_TOKENS, thinking: { type: 'adaptive' }, output_config: { effort: target.effort } } : { reasoning_effort: target.effort, max_completion_tokens: CANARY_MAX_TOKENS }) };
    const response = await fetcher(connection.endpoint.replace(/\/$/, '') + (claude ? '/v1/messages' : '/v1/chat/completions'), { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(CANARY_TIMEOUT_MS), redirect: 'error' });
    if (!response.ok) throw new Error(`Proxy returned HTTP ${response.status}`);
    const r = await response.json() as { model?: string; stop_reason?: string; content?: { type: string; text?: string }[]; choices?: { finish_reason?: string; message?: { content?: string } }[]; usage?: { output_tokens?: number; completion_tokens?: number; output_tokens_details?: { thinking_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number } } };
    if (!r || typeof r !== 'object') throw new Error('Invalid response object');
    if (r.stop_reason === 'max_tokens' || r.choices?.[0]?.finish_reason === 'length') throw new Error('Reply hit the output token limit');
    const text = claude ? Array.isArray(r.content) ? r.content.filter((b: { type: string }) => b.type === 'text').map((b) => b.text ?? '').join('\n') : null : r.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error('Response contains no text');
    result.answer = [...text.matchAll(/^[ \t]*ANSWER:[ \t]*([^\r\n]*)$/gim)].at(-1)?.[1]?.trim().replace(/^[*_`]+|[*_`]+$/g, '').replace(/\.$/, '').replace(/^[*_`]+|[*_`]+$/g, '').trim() ?? null;
    result.outcome = result.answer?.toLowerCase() === probe.answer.trim().toLowerCase() ? 'pass' : 'fail';
    result.effectiveModel = typeof r.model === 'string' ? r.model : null;
    const count = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
    result.outputTokens = count(claude ? r.usage?.output_tokens : r.usage?.completion_tokens);
    result.thinkingTokens = count(claude ? r.usage?.output_tokens_details?.thinking_tokens : r.usage?.completion_tokens_details?.reasoning_tokens);
  } catch (e) { result.error = e instanceof Error ? e.message : String(e); }
  result.latencyMs = Date.now() - start;
  return result;
}
