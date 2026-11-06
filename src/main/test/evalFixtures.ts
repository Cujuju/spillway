import type { CaptureRecord } from '@shared/archive';
import type { EvalAnnotation, EvalCase } from '@shared/evalCase';
import { portableCapture } from '../archiveExport';
import { missingContext } from '../evalCaseCodec';

export const annotation = (): EvalAnnotation => ({ title: 'Synthetic text task', notes: 'Test only', expectedOutcome: 'Answer hello', assertions: [{ kind: 'contains', value: 'hello' }], context: { repository: 'example/repo', revision: 'unverified-test-revision', workspace: 'unknown', notes: 'No checkout or tools available' } });
export const captureRecord = (extra: Partial<CaptureRecord> = {}): CaptureRecord => ({ id: 'capture-test', traceId: 'trace-synthetic-001', epoch: 'test-epoch', sequence: 1, startedAt: new Date().toISOString(), method: 'POST', path: '/v1/chat/completions', status: 200, state: 'complete', reason: '', request: JSON.stringify({ model: 'synthetic-model', messages: [{ role: 'user', content: 'Say hello' }], stream: true, max_tokens: 16 }), response: 'data: [DONE]\n', requestType: 'application/json', responseType: 'text/event-stream', requestEncoding: '', responseEncoding: '', format: 'http', requestDecoded: true, responseDecoded: true, frames: [], ...extra });
export function evalFixture(): EvalCase {
  const r = captureRecord();
  const capture = portableCapture({ schemaVersion: 1, captureEpoch: r.epoch, captureSequence: r.sequence, id: `trace:${r.traceId}`, traceId: r.traceId, at: r.startedAt, state: r.state, reason: '', sessionId: null, model: 'synthetic-model', provider: '', client: null, method: r.method, path: r.path, status: 200, bytes: 100, captureId: r.id }, JSON.stringify(r), '[]', true);
  return { type: 'eval-case', schemaVersion: 1, id: 'case:00000000-0000-4000-8000-000000000001', revision: 1, parentRevision: null, createdAt: r.startedAt, annotation: annotation(), capture, provenance: { source: 'local-archive', archiveId: capture.entry.id, importedFrom: null }, missingContext: missingContext(capture), taskOutcome: 'unknown' };
}
