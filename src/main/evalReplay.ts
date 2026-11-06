import { randomUUID } from 'node:crypto';
import { EVAL_LIMITS, type EvalCase, type EvalReplayPreview, type EvalReplayResult } from '@shared/evalCase';
import { object, sha256 } from './evalCaseCodec';

export interface ReplayTarget { endpoint: string; clientApiKey: string }
export function replayDestination(target: ReplayTarget, route: string): string {
  const url = new URL(target.endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Replay requires the current loopback proxy root endpoint');
  if (!['/v1/chat/completions', '/v1/messages'].includes(route)) throw new Error('Unsupported replay route');
  return new URL(route, url).href;
}

function textContent(v: unknown): boolean {
  return typeof v === 'string' || Array.isArray(v) && v.length > 0 && v.length <= 200 && v.every((x) => object(x) && Object.keys(x).every((k) => ['type', 'text'].includes(k)) && x.type === 'text' && typeof x.text === 'string');
}
function buildRequest(c: EvalCase): { route: string; body: Record<string, unknown>; model: string; maxTokens: number } {
  const p = c.capture.payload, e = c.capture.entry;
  if (e.state !== 'complete' || p.state !== 'included' || !p.data) throw new Error('Replay requires a complete retained request; omitted, partial, pending, malformed and expired content cannot replay.');
  const d = p.data;
  if (d.format !== 'http' || e.method !== 'POST' || !['/v1/chat/completions', '/v1/messages'].includes(e.path)) throw new Error('Only text-only HTTP chat completions and Anthropic messages are supported. Responses/Codex, WebSocket and agent-task harnesses are unavailable.');
  if ((!d.requestDecoded && !['', 'identity'].includes(d.requestEncoding)) || !d.requestType.toLowerCase().includes('application/json')) throw new Error('Request encoding or protocol is opaque/unsupported.');
  if (Buffer.byteLength(d.request) > EVAL_LIMITS.requestBytes) throw new Error('Replay request exceeds 256 KiB');
  const raw: unknown = JSON.parse(d.request);
  if (!object(raw)) throw new Error('Request must be a JSON object.');
  const isClaude = e.path === '/v1/messages';
  const allowed = ['model', 'messages', 'stream', 'max_tokens', 'temperature', 'top_p', ...(isClaude ? ['system'] : [])];
  if (Object.keys(raw).some((k) => !allowed.includes(k))) throw new Error('Request has unsupported fields (including tools, state references, attachments or routing extensions). No tools or external context will execute.');
  if (typeof raw.model !== 'string' || !/^[\w./:-]{1,200}$/.test(raw.model)) throw new Error('Model identity is missing or unsupported.');
  if (!Array.isArray(raw.messages) || !raw.messages.length || raw.messages.length > 200 || raw.messages.some((m) => !object(m) || Object.keys(m).some((k) => !['role', 'content'].includes(k)) || !(isClaude ? ['user', 'assistant'] : ['system', 'user', 'assistant']).includes(m.role as string) || !(isClaude ? textContent(m.content) : typeof m.content === 'string'))) throw new Error('Messages need self-contained text content and supported roles; tool calls/results and attachments are unsupported.');
  if (raw.system !== undefined && !textContent(raw.system)) throw new Error('Unsupported system context.');
  if (raw.stream !== undefined && typeof raw.stream !== 'boolean') throw new Error('Invalid stream setting.');
  if (raw.max_tokens !== undefined && (!Number.isSafeInteger(raw.max_tokens) || (raw.max_tokens as number) < 1)) throw new Error('Invalid output token limit.');
  for (const k of ['temperature', 'top_p']) if (raw[k] !== undefined && (typeof raw[k] !== 'number' || !Number.isFinite(raw[k]) || (raw[k] as number) < 0 || (raw[k] as number) > (k === 'top_p' || isClaude ? 1 : 2))) throw new Error(`Invalid ${k}.`);
  const maxTokens = Math.min(typeof raw.max_tokens === 'number' ? raw.max_tokens : 512, 2048);
  return { route: e.path, model: raw.model, maxTokens, body: { ...raw, stream: false, max_tokens: maxTokens } };
}

export function replayPreview(c: EvalCase, target: ReplayTarget): EvalReplayPreview {
  const preview: EvalReplayPreview = { id: randomUUID(), caseId: c.id, revision: c.revision, supported: false, reasons: [], mode: 'model-call', agentTask: 'unsupported',
    destination: '', model: null, route: null, request: null, assertions: structuredClone(c.annotation.assertions), expectedOutcome: c.annotation.expectedOutcome, missingContext: [...c.missingContext],
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), environment: 'Current local Spillway proxy and its current model/account routing. One non-streaming text model call. No repository, shell, tools, files or agent harness. Original sampling retained; output tokens capped. Calls may incur provider usage. Expected-outcome prose is for human review only.', maxOutputTokens: 0, timeoutMs: EVAL_LIMITS.timeoutMs,
    inputFidelity: `Reconstructed model call with stream disabled and token cap applied; byte-faithful original replay is not promised. ${c.portability ? `Export policy ${c.portability.policy}; protocol ${c.portability.protocol}. Credential redaction can change input and assertions.` : c.provenance.source === 'portable-import' ? 'Imported content has unverified transformation history; credential redaction or other changes may have altered input and assertions.' : 'Retained downstream protocol only; hidden state is unavailable.'}` };
  try {
    const r = buildRequest(c); preview.destination = replayDestination(target, r.route); preview.route = r.route; preview.model = r.model; preview.request = JSON.stringify(r.body, null, 2); preview.maxOutputTokens = r.maxTokens;
    if (!preview.assertions.length) throw new Error('Add at least one explicit literal assertion before replay.');
    preview.supported = true;
  } catch (e) { preview.reasons.push(e instanceof Error ? e.message : 'Unsupported request'); }
  return preview;
}

export function compareOutput(output: string, assertions: EvalReplayPreview['assertions']): EvalReplayResult['checks'] {
  return assertions.map((assertion) => ({ assertion, passed: assertion.kind === 'contains' ? output.includes(assertion.value) : assertion.kind === 'not-contains' ? !output.includes(assertion.value) : output === assertion.value }));
}

/** One explicit start per preview; imported/captured destinations and credentials never enter the client. */
export class EvalReplay {
  private current: { preview: EvalReplayPreview; result: EvalReplayResult; targetHash: string; controller: AbortController } | null = null;
  constructor(private target: () => ReplayTarget, private fetcher: typeof fetch = fetch) {}
  prepare(c: EvalCase): EvalReplayPreview {
    if (this.current?.result.state === 'running') throw new Error('Cancel the active replay first');
    const target = this.target(), preview = replayPreview(c, target);
    this.current = { preview: structuredClone(preview), targetHash: sha256(JSON.stringify(target)), controller: new AbortController(), result: { id: preview.id, caseId: c.id, revision: c.revision, state: 'preview', httpStatus: null, output: '', error: null, comparison: 'not-evaluated', checks: [], taskOutcome: 'unknown' } };
    return preview;
  }
  status(id: string): EvalReplayResult {
    if (this.current?.preview.id !== id) throw new Error('Replay no longer available');
    return structuredClone(this.current.result);
  }
  start(id: string): EvalReplayResult {
    const job = this.current;
    if (!job || job.preview.id !== id || !job.preview.supported || job.result.state !== 'preview' || Date.now() >= Date.parse(job.preview.expiresAt)) throw new Error('Prepare a supported replay preview first');
    const target = this.target();
    if (sha256(JSON.stringify(target)) !== job.targetHash) throw new Error('Proxy destination/auth changed; prepare and review a new preview');
    job.result.state = 'running';
    void this.execute(job, target);
    return this.status(id);
  }
  cancel(id?: string): void {
    const job = this.current;
    if (job && (!id || job.preview.id === id) && ['preview', 'running'].includes(job.result.state)) { job.result.state = 'canceled'; job.controller.abort(); }
  }
  forget(caseId?: string): void { if (!caseId || this.current?.preview.caseId === caseId) { this.cancel(); this.current = null; } }
  private async execute(job: NonNullable<EvalReplay['current']>, target: ReplayTarget): Promise<void> {
    const { result, controller, preview } = job;
    const timer = setTimeout(() => controller.abort(new Error('Replay deadline exceeded')), EVAL_LIMITS.timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const aborted = new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Replay canceled or deadline exceeded')), { once: true }));
    const wait = <T>(promise: Promise<T>) => Promise.race([promise, aborted]);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (preview.route === '/v1/messages') { headers['anthropic-version'] = '2023-06-01'; headers['X-Api-Key'] = target.clientApiKey; }
      else headers.Authorization = `Bearer ${target.clientApiKey}`;
      const response = await wait(this.fetcher(preview.destination, { method: 'POST', headers, body: JSON.stringify(JSON.parse(preview.request!)), redirect: 'error', signal: controller.signal }));
      result.httpStatus = response.status;
      if (!response.ok) { controller.abort(); throw new Error(`Proxy returned HTTP ${response.status}; task outcome remains unknown`); }
      if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new Error('Replay response must be non-streaming JSON');
      if (!response.body) throw new Error('Replay response body is unavailable');
      reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      for (;;) {
        const part = await wait(reader.read()); if (part.done) break;
        size += part.value.byteLength; if (size > EVAL_LIMITS.responseBytes) throw new Error('Replay response exceeded 256 KiB'); chunks.push(part.value);
      }
      const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      let output: string;
      if (!object(data) || data.error) throw new Error('Malformed/error model response');
      if (preview.route === '/v1/messages') {
        if (data.type !== 'message' || !['end_turn', 'stop_sequence'].includes(data.stop_reason as string) || !Array.isArray(data.content) || !data.content.length || data.content.some((b) => !object(b) || b.type !== 'text' || typeof b.text !== 'string')) throw new Error('Model response is incomplete or requires unsupported tools');
        output = data.content.map((b) => (b as { text: string }).text).join('');
      } else {
        const choices = data.choices;
        if (!Array.isArray(choices) || choices.length !== 1 || !object(choices[0]) || choices[0].finish_reason !== 'stop' || !object(choices[0].message) || typeof choices[0].message.content !== 'string' || choices[0].message.tool_calls || choices[0].message.function_call) throw new Error('Model response is incomplete or requires unsupported tools');
        output = choices[0].message.content;
      }
      if (Buffer.byteLength(output) > EVAL_LIMITS.outputBytes) throw new Error('Replay output exceeded 64 KiB');
      if (controller.signal.aborted || result.state === 'canceled') throw new Error('Replay canceled');
      result.output = output; result.checks = compareOutput(output, preview.assertions); result.comparison = result.checks.every((c) => c.passed) ? 'pass' : 'fail'; result.state = 'complete';
    } catch (e) {
      if (result.state !== 'canceled') { result.state = 'failed'; result.error = e instanceof Error ? e.message : 'Replay failed'; }
    } finally {
      clearTimeout(timer); controller.abort();
      if (reader) void reader.cancel().catch((e) => console.error('Replay reader cleanup failed', e));
    }
  }
}
