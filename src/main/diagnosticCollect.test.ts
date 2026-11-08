import { expect, it } from 'vitest';
import { DEFAULT_ARCHIVE_POLICY, type ArchiveDetail } from '@shared/archive';
import { DIAGNOSTIC_LIMITS, type DiagnosticSelection, type DiagnosticSource } from '@shared/diagnosticBundle';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { parseActivityEvent } from './sse';
import { buildDiagnosticBundle, type DiagnosticContext } from './diagnosticCollect';
import { DiagnosticSanitizer, diagnosticErrorClass } from './diagnosticSanitize';

export const selection: DiagnosticSelection = { operationId: 'operation-one', traceIds: ['full-trace-one'], includeBodies: false, includeSettings: true, includeLogs: true, includeMessages: false };
export function source(extra: Partial<ArchiveDetail> = {}): DiagnosticSource {
  return { detail: { schemaVersion: 1, id: 'trace:full-trace-one', traceId: 'full-trace-one', at: '2026-11-05T12:00:00.000Z', captureId: 'capture-one', captureEpoch: 'epoch-one', captureSequence: 12,
    state: 'complete', reason: '', sessionId: 'claude:private-session', model: 'model-alias', provider: 'claude', client: 'Claude Code', method: 'POST', path: '/v1/messages', status: 200, bytes: 1000,
    request: '{"input":"private prompt","api_key":"secret-key"}', response: 'data: {"delta":{"text":"hello"}}\n\n', requestType: 'application/json', responseType: 'text/event-stream',
    requestEncoding: '', responseEncoding: '', requestDecoded: true, responseDecoded: true, format: 'http', frames: [], attempts: [], ...extra },
  attempts: [parseActivityEvent(JSON.stringify({ request_id: 'private-request', selection_id: 'private-selection', trace_id: 'full-trace-one', session_id: 'claude:private-session', parent_session_id: 'claude:private-parent', at: '2026-11-05T12:00:00.000Z', provider: 'claude', alias: 'model-alias', model: 'model-real', reasoning_effort: 'high', auth_index: 'private-account', failed: true, status_code: 429, error: 'access_token=secret-error person@example.com', upstream_transport: 'websocket+http', downstream_transport: 'http', transport_fallback_reason: 'websocket_upgrade_426' }))!], attemptsOmitted: 0, attemptsUnavailable: 0 };
}
export function context(): DiagnosticContext {
  return { app: { version: '1.2.3', build: 'abc123', builtAt: null, modified: false }, proxy: { state: 'running', pid: 123, port: 8317, startedAt: null, lastError: 'private error', executablePath: 'C:\\private\\proxy.exe', endpoint: 'http://private:8317?token=secret', userConfigError: null, build: null },
    settings: structuredClone(DEFAULT_SETTINGS), archive: { policy: { ...DEFAULT_ARCHIVE_POLICY }, bytes: 1, entries: 1, bodies: 1, epoch: 'epoch', sequence: 1, dropped: 3, gaps: 2, restarts: 1, rejected: 0 },
    logs: [{ at: '2026-11-05T12:00:00Z', stream: 'app', text: 'spawn failed: password=log-secret C:\\Users\\private\\proxy.exe person@example.com' }, { at: '2026-11-05T12:00:00Z', stream: 'stdout', text: 'access_token=never-export' }], knownSecrets: ['literal-key-123456789'] };
}
it('defaults to useful allowlisted metadata with local correlation and no body/message text', () => {
  const a = source(); a.attempts[0]!.movedFrom = 'previous-account';
  a.attempts.push({ ...a.attempts[0]!, requestId: 'retry', authIndex: 'previous-account', movedFrom: null, failed: false, error: null, effectiveModel: null, reasoningEffort: null });
  const bundle = buildDiagnosticBundle(selection, [a], context(), 1);
  const json = JSON.stringify(bundle), record = bundle.records[0]!;
  expect(json).not.toMatch(/private-(account|session|parent|request|selection)|previous-account|secret-error|private prompt|never-export|private.error|private:8317|proxy\.exe/);
  expect(record).toMatchObject({ traceId: 'full-trace-one', capture: { state: 'complete', sequence: 12 }, bodies: { disposition: 'omitted', reason: 'body-export-not-selected' }, attempts: [{ account: 'account-1', movedFromAccount: 'account-2', selection: 'selection-1', errorClass: 'rate-limit', effectiveModel: 'model-real', reasoningEffort: 'high', upstreamTransport: 'websocket+http', transportFallbackReason: 'websocket_upgrade_426' }, { account: 'account-2', effectiveModel: null, reasoningEffort: null }] });
  expect(bundle.supervisor).toMatchObject({ kind: 'limited-supervisor-summary', freeTextOmitted: true, lines: [{ classification: 'spawn-failed' }] });
  expect(bundle.versions.proxy).toBeNull(); expect(bundle.policy.semanticOutcome).toBe('not-evaluated');
});
it('distinguishes capture unavailable, export omission, pending/partial capture and missing attempt metadata', () => {
  const sources = [source({ state: 'expired', bytes: 0 }), source({ state: 'pending' }), source({ state: 'partial' }), { detail: null, attempts: [], attemptsOmitted: 0, attemptsUnavailable: 0 }];
  sources[2]!.attemptsUnavailable = 2;
  const bundle = buildDiagnosticBundle({ ...selection, traceIds: ['full-trace-one', 'full-trace-two', 'full-trace-three', 'full-trace-four'] }, sources, context(), 1);
  expect(bundle.counts).toEqual({ selected: 4, included: 3, unavailable: 1, partial: 2, redacted: 3, omitted: 0, bodiesIncluded: 0, bodiesUnavailable: 2, bodiesOmitted: 2 });
  expect(bundle.records[0]).toMatchObject({ capture: { state: 'expired' }, bodies: { disposition: 'unavailable', reason: 'capture-expired' } });
  expect(bundle.records[3]).toMatchObject({ captureState: 'unknown', availability: 'unavailable' });
});
it('includes Activity metadata without archive detail and reports capture as unknown', () => {
  const activity = { ...source(), detail: null };
  const bundle = buildDiagnosticBundle({ ...selection, includeBodies: true }, [activity], context(), 1);
  expect(bundle.counts).toMatchObject({ included: 1, unavailable: 0, bodiesIncluded: 0, bodiesUnavailable: 1 });
  expect(bundle.records[0]).toMatchObject({ id: 'trace:full-trace-one', traceId: 'full-trace-one', availability: 'included', capture: { state: 'unknown' },
    attempts: [{ metadataSource: 'activity', effectiveModel: 'model-real', reasoningEffort: 'high' }], bodies: { disposition: 'unavailable', reason: 'capture-unknown' } });
  expect(JSON.stringify(bundle)).not.toMatch(/private-(account|session|request)|secret-error/);
});
it('requires body opt-in and structurally drops nested credential/header fields while preserving user-inspected prompt text', () => {
  const raw = JSON.stringify({ input: [{ text: 'project phrase not automatically recognized', nested: { access_token: 'unprefixed-token', headers: { custom: 'sensitive-header' }, token: 'plain-token' } }], password: 'plain-password', harmless: 'Bearer token-value literal-key-123456789 person@example.com https://example.com?key=abc' });
  const bundle = buildDiagnosticBundle({ ...selection, includeBodies: true }, [source({ request: raw })], context(), 1);
  const json = JSON.stringify(bundle);
  expect(json).not.toMatch(/unprefixed-token|sensitive-header|plain-token|plain-password|token-value|literal-key-123456789|person@example.com|https:\/\/example/);
  expect(json).toContain('project phrase not automatically recognized'); expect(bundle.counts.bodiesIncluded).toBe(1);
  expect(bundle.policy.arbitraryTextRequiresInspection).toBe(true); expect(bundle.warning).toContain('arbitrary prompt secrets cannot all be detected');
});
it('never includes unparsed wire/binary content and flags structured partial event streams', () => {
  const a = source({ request: 'auth-file-secret', requestDecoded: false, response: 'data: {"delta":"ok"}\n\ndata: {broken\n\n' });
  const bundle = buildDiagnosticBundle({ ...selection, includeBodies: true }, [a], context(), 1);
  expect(JSON.stringify(bundle)).not.toContain('auth-file-secret');
  expect(bundle.counts.partial).toBe(1); expect(bundle.records[0]).toMatchObject({ bodies: { disposition: 'included', partial: true } });
  const ws = buildDiagnosticBundle({ ...selection, includeBodies: true }, [source({ format: 'websocket', frames: [{ index: 1, direction: 'request', at: '2026-11-05', type: 'binary', payload: 'secret-base64', truncated: false }] })], context(), 1);
  expect(JSON.stringify(ws)).not.toContain('secret-base64'); expect(ws.counts.bodiesOmitted).toBe(1); expect(ws.counts.partial).toBe(1);
});
it('bounds payload structure, labels, log messages and record body bytes with explicit partial/omission', () => {
  const a = source({ request: JSON.stringify(Array.from({ length: 1000 }, () => 'x'.repeat(1000))) });
  const bundle = buildDiagnosticBundle({ ...selection, includeBodies: true, includeMessages: true }, [a], context(), 1);
  expect(bundle.records[0]).toMatchObject({ bodies: { disposition: 'omitted', reason: 'export-body-byte-limit', partial: true } });
  expect(bundle.counts.partial).toBe(1);
  const s = new DiagnosticSanitizer(); let raw = '"foo"'; for (let i = 0; i < 30; i++) raw = `[${raw}]`;
  expect(s.payload(raw).partial).toBe(true); expect(s.payload('{invalid').reason).toBe('unstructured-or-invalid-payload');
  expect(s.payload('x'.repeat(1024 * 1024 + 1)).reason).toBe('input-byte-limit');
  expect(buildDiagnosticBundle(selection, [source({ model: 'x'.repeat(200) })], context(), 1).counts.partial).toBe(1);
});
it('allows explicit redacted messages, bounds logs, and always excludes stdout/stderr', () => {
  const c = context(); c.logs.push(...Array.from({ length: DIAGNOSTIC_LIMITS.logs + 1 }, (_, i) => ({ ...c.logs[0]!, text: `proxy error: {"access_token":"secret-${i}"} person@example.com` })));
  const bundle = buildDiagnosticBundle({ ...selection, includeMessages: true }, [source()], c, 1);
  expect(bundle.supervisor).toMatchObject({ included: 100, omitted: 2, redacted: 100, kind: 'redacted-supervisor-messages' });
  expect(JSON.stringify(bundle)).not.toMatch(/secret-error|log-secret|secret-\d+|person@example.com|never-export/);
  expect(bundle.records[0]).toMatchObject({ attempts: [{ errorMessage: expect.stringContaining('[redacted]') }] });
});
it('keeps the exact settings allowlist and excludes paths, preferred accounts, tray identities and zip code', () => {
  const c = context(); c.settings.proxy.preferredAccounts = { claude: 'secret-account' }; c.settings.proxy.executablePath = 'private-executable'; c.settings.activity.zipCode = 'private-location';
  const bundle = buildDiagnosticBundle(selection, [source()], c, 1);
  expect(Object.keys(bundle.settings!.proxy)).toEqual(['autoStart', 'allowLan', 'strategy', 'apiKeyOrder', 'sessionAffinity', 'sessionAffinityTtlMinutes', 'sessionHoldMinutes', 'restartOnCrash', 'serverErrors', 'firstByteTimeoutSeconds', 'usageLookupSettleSeconds', 'requestLog', 'clientDrift']);
  expect(Object.keys(bundle.settings!)).toEqual(['proxy', 'activity', 'archive']); expect(JSON.stringify(bundle)).not.toMatch(/secret-account|private-executable|private-location/);
});
it('classifies failures without claiming semantic success or leaking the error string', () => {
  expect(diagnosticErrorClass(true, 401, 'secret')).toBe('authentication'); expect(diagnosticErrorClass(true, 403, null)).toBe('permission');
  expect(diagnosticErrorClass(true, 502, null)).toBe('server'); expect(diagnosticErrorClass(true, null, 'deadline exceeded')).toBe('timeout');
  expect(diagnosticErrorClass(true, null, 'ECONNRESET')).toBe('connection'); expect(diagnosticErrorClass(true, null, 'aborted')).toBe('canceled');
  expect(diagnosticErrorClass(true, 400, null)).toBe('client'); expect(diagnosticErrorClass(true, null, 'anything')).toBe('unknown'); expect(diagnosticErrorClass(false, null, null)).toBeNull();
});
it('normalizes control, bidi and ANSI sequences before secret matching, including adjacent word characters', () => {
  const s = new DiagnosticSanitizer(['known-secret-123456']);
  for (const poison of ['key sk-ab\u0007cdefghijklmnop', 'ghp_abcdef\u202eghijklmnopqrst', 'eyJabc.\u0000eyJpayload.sig', '\u001b[32msk-proj-ABCDEFGHIJKLMNOP\u001b[0m', '\u001b[1mBearer abcdefghijklmnop', 'prefixsk-abcdefghijklmnop', 'known-secret-\u202e123456']) {
    const output = s.text(poison); expect(output).toContain('[redacted]'); expect(output).not.toMatch(/sk-|ghp_|eyJ|Bearer|known-secret/);
  }
});
it('drops generic token fields recursively while retaining plural token accounting fields', () => {
  const s = new DiagnosticSanitizer();
  const payload = s.payload('{"session_token":"opaque-value-123","github_token":"opaque2","csrfToken":"x","nested":{"customToken":"opaque3"},"input_tokens":42}');
  expect(payload.content).toEqual({ nested: {}, input_tokens: 42 }); expect(JSON.stringify(payload)).not.toContain('opaque');
});
it('handles repeated-boundary email poison with a single token scan and keeps output bounded', () => {
  const s = new DiagnosticSanitizer();
  const poison = `${'a.'.repeat(150)}@ ${'a-'.repeat(300)}@ `;
  const payload = s.payload(JSON.stringify(Array.from({ length: 1000 }, () => poison)));
  expect(payload.content).toBeDefined(); expect(s.text(`${'a.'.repeat(150)}@example.com`)).toBe('[redacted]');
  expect(s.text('x'.repeat(2 * 1024 * 1024)).length).toBeLessThan(4200);
});
