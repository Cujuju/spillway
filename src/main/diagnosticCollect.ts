import { DIAGNOSTIC_LIMITS, DIAGNOSTIC_WARNING, type DiagnosticAttempt, type DiagnosticCounts, type DiagnosticSelection, type DiagnosticSource } from '@shared/diagnosticBundle';
import type { ArchivePolicy, ArchiveStatus } from '@shared/archive';
import type { AppSettings } from '@shared/settings';
import type { BuildInfo } from '@shared/buildInfo';
import type { LogLine, ProxyStatus } from '@shared/types';
import { normalizeTransport } from '@shared/activityTransport';
import { DiagnosticSanitizer, diagnosticErrorClass } from './diagnosticSanitize';

export interface DiagnosticContext {
  app: BuildInfo; proxy: ProxyStatus; settings: AppSettings; archive: ArchiveStatus; logs: LogLine[]; knownSecrets: string[];
  logCount?: number;
}
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const at = (v: string) => Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const code = (v: unknown) => typeof v === 'string' && /^[a-z0-9][a-z0-9_:-]{0,79}$/i.test(v) ? v : null;
const ROUTES = new Set(['/v1/messages', '/v1/responses', '/v1/chat/completions', '/backend-api/codex/responses', '/responses', '/chat/completions']);

export function diagnosticSettings(s: AppSettings, policy: ArchivePolicy) {
  return {
    proxy: { autoStart: s.proxy.autoStart, allowLan: s.proxy.allowLan, strategy: s.proxy.strategy, apiKeyOrder: s.proxy.apiKeyOrder,
      sessionAffinity: s.proxy.sessionAffinity, sessionAffinityTtlMinutes: s.proxy.sessionAffinityTtlMinutes, sessionHoldMinutes: s.proxy.sessionHoldMinutes,
      restartOnCrash: s.proxy.restartOnCrash, serverErrors: s.proxy.serverErrors, firstByteTimeoutSeconds: s.proxy.firstByteTimeoutSeconds,
      usageLookupSettleSeconds: s.proxy.usageLookupSettleSeconds, requestLog: s.proxy.requestLog, clientDrift: s.proxy.clientDrift },
    activity: { retentionDays: s.activity.retentionDays },
    archive: { captureBodies: policy.captureBodies, retentionDays: policy.retentionDays, maxBytes: policy.maxBytes },
  };
}
function attempt(e: DiagnosticAttempt, s: DiagnosticSanitizer, messages: boolean) {
  return {
    request: s.alias('request', e.requestId), selection: s.alias('selection', e.selectionId), at: at(e.at),
    account: s.alias('account', e.authIndex), movedFromAccount: s.alias('account', e.movedFrom),
    conversation: s.alias('conversation', e.sessionId), parentConversation: s.alias('conversation', e.parentSessionId),
    provider: s.label(e.provider), client: s.label(e.client), requestedModel: s.label(e.model), effectiveModel: s.label(e.effectiveModel), reasoningEffort: s.label(e.reasoningEffort),
    metadataSource: e.metadataSource ?? 'activity',
    stream: typeof e.stream === 'boolean' ? e.stream : null, failed: typeof e.failed === 'boolean' ? e.failed : null, statusCode: number(e.statusCode), errorClass: diagnosticErrorClass(e.failed === true, e.statusCode ?? null, e.error),
    errorMessage: messages && e.error ? s.text(e.error) : null,
    latencyMs: number(e.latencyMs), ttftMs: number(e.ttftMs), inputTokens: number(e.inputTokens), outputTokens: number(e.outputTokens),
    cachedTokens: number(e.cachedTokens), cacheWriteTokens: number(e.cacheWriteTokens), ...normalizeTransport(e),
  };
}
function body(source: DiagnosticSource, enabled: boolean, s: DiagnosticSanitizer) {
  const d = source.detail;
  if (!d) return { disposition: 'unavailable', reason: 'capture-unknown', partial: false };
  if (!d.bytes || ['missing', 'expired', 'unknown'].includes(d.state)) return { disposition: 'unavailable', reason: `capture-${d.state}`, partial: false };
  if (!enabled) return { disposition: 'omitted', reason: 'body-export-not-selected', partial: false };
  const parse = (raw: string, decoded: boolean) => !raw ? { reason: 'no-observed-content', partial: false }
    : decoded ? s.payload(raw) : { reason: 'undecoded-content-omitted', partial: true };
  const content = d.format === 'websocket'
    ? { frames: d.frames.map((f) => ({ index: f.index, direction: f.direction, at: at(f.at), type: f.type, truncated: f.truncated || !!f.cut,
      payload: f.type === 'text' ? s.payload(f.payload) : { reason: 'binary-frame-omitted', partial: true } })) }
    : { request: parse(d.request, d.requestDecoded), response: parse(d.response, d.responseDecoded) };
  if (Buffer.byteLength(JSON.stringify(content)) > DIAGNOSTIC_LIMITS.bodyBytes) return { disposition: 'omitted', reason: 'export-body-byte-limit', partial: true };
  const parts = content.frames ? content.frames.map((f) => f.payload) : [content.request!, content.response!];
  const any = parts.some((p) => p.content !== undefined);
  const partial = parts.some((p) => p.partial) || d.state === 'pending' || d.state === 'partial' || !!d.requestCut || !!d.responseCut || d.frames.some((f) => f.truncated || !!f.cut);
  return { disposition: any ? 'included' : 'omitted', reason: any ? 'structurally-redacted-user-inspected-content' : 'no-supported-structured-content', partial, content };
}
function logClass(text: string): string {
  if (text.startsWith('starting ')) return 'starting';
  if (text.startsWith('using the proxy at ')) return 'attached';
  if (text.startsWith('config.user.yaml ignored:')) return 'config-rejected';
  if (text.startsWith('spawn failed:')) return 'spawn-failed';
  if (text.startsWith('proxy error:')) return 'process-error';
  if (text.startsWith('proxy exited ')) return 'exited';
  if (text.startsWith('proxy did not answer ')) return 'readiness-timeout';
  if (text.startsWith('crashed ')) return 'crash-loop';
  if (text.startsWith('restarting ')) return 'restart-scheduled';
  if (text.startsWith('stopping proxy')) return 'stopping';
  if (text.startsWith('proxy did not exit ')) return 'stop-timeout';
  if (/^Port \d+ is already in use/.test(text)) return 'port-busy';
  return 'other';
}
export function buildDiagnosticBundle(selection: DiagnosticSelection, sources: DiagnosticSource[], context: DiagnosticContext, now: number, s = new DiagnosticSanitizer(context.knownSecrets)) {
  const counts: DiagnosticCounts = { selected: selection.traceIds.length, included: 0, unavailable: 0, partial: 0, redacted: 0, omitted: selection.excludedRecords ?? 0, bodiesIncluded: 0, bodiesUnavailable: 0, bodiesOmitted: 0 };
  const records = sources.map((source, index) => {
    const d = source.detail, traceId = selection.traceIds[index]!;
    if (!d && !source.attempts.length) { counts.unavailable++; counts.bodiesUnavailable++; return { id: `trace:${traceId}`, traceId, availability: 'unavailable', reason: 'identity-not-retained-at-collection', captureState: 'unknown' }; }
    const start = s.changes, truncated = s.truncations;
    const bodies = body(source, selection.includeBodies, s);
    counts.included++;
    if (bodies.disposition === 'included') counts.bodiesIncluded++;
    else if (bodies.disposition === 'unavailable') counts.bodiesUnavailable++;
    else counts.bodiesOmitted++;
    const partial = ['partial', 'pending'].includes(d?.state ?? 'unknown') || bodies.partial || source.attemptsOmitted > 0 || source.attemptsUnavailable > 0 || d?.attempts.length === DIAGNOSTIC_LIMITS.attempts;
    if (partial) counts.partial++;
    const record = {
      id: d?.id ?? `trace:${traceId}`, traceId: d?.traceId ?? traceId, cursor: d ? JSON.stringify([d.at, d.id]) : null, at: d ? at(d.at) : null, availability: 'included', partial,
      capture: d ? { schemaVersion: d.schemaVersion, state: d.state, reason: code(d.reason), id: s.label(d.captureId), epoch: s.label(d.captureEpoch), sequence: number(d.captureSequence), storedBytes: number(d.bytes),
        format: d.format, requestDecoded: d.requestDecoded, responseDecoded: d.responseDecoded, requestType: s.label(d.requestType), responseType: s.label(d.responseType), requestEncoding: s.label(d.requestEncoding), responseEncoding: s.label(d.responseEncoding) } : { state: 'unknown' },
      provider: s.label(d?.provider), requestedModel: s.label(d?.model), client: s.label(d?.client), conversation: s.alias('conversation', d?.sessionId),
      method: d && ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].includes(d.method) ? d.method : null,
      route: d && ROUTES.has(d.path) ? d.path : null, downstreamStatus: number(d?.status),
      attempts: source.attempts.map((e) => attempt(e, s, selection.includeMessages)), attemptsOmitted: source.attemptsOmitted,
      attemptsUnavailable: source.attemptsUnavailable, attemptLinksAtRetentionLimit: d?.attempts.length === DIAGNOSTIC_LIMITS.attempts, bodies,
    };
    if (s.truncations !== truncated && !record.partial) { record.partial = true; counts.partial++; }
    if (s.changes !== start) counts.redacted++;
    return record;
  });
  const logs = context.logs.filter((l) => l.stream === 'app');
  const selectedLogs = selection.includeLogs ? logs.slice(-DIAGNOSTIC_LIMITS.logs) : [];
  const lines = selectedLogs.map((l) => {
    const changes = s.changes, truncations = s.truncations;
    const message = selection.includeMessages ? s.text(l.text) : undefined;
    return { at: at(l.at), stream: 'app', classification: logClass(l.text), ...(message !== undefined ? { message } : {}), redacted: s.changes !== changes, partial: s.truncations !== truncations };
  });
  const version = (v: BuildInfo | null) => v && ({ version: s.label(v.version), build: s.label(v.build), modified: v.modified === true, builtAt: v.builtAt ? at(v.builtAt) : null });
  return {
    format: 'spillway-diagnostic-bundle', schemaVersion: 1, createdAt: new Date(now).toISOString(), warning: DIAGNOSTIC_WARNING,
    policy: { bodiesSelected: selection.includeBodies, messagesSelected: selection.includeMessages, settingsSelected: selection.includeSettings, logsSelected: selection.includeLogs,
      limits: DIAGNOSTIC_LIMITS, recordCountsOverlap: true, arbitraryTextRequiresInspection: selection.includeBodies || selection.includeMessages, semanticOutcome: 'not-evaluated' },
    versions: { app: version(context.app), proxy: version(context.proxy.build), proxyState: context.proxy.state },
    counts, archiveHealth: { dropped: context.archive.dropped, gaps: context.archive.gaps, restarts: context.archive.restarts, rejected: context.archive.rejected, countersOverlap: true },
    settings: selection.includeSettings ? diagnosticSettings(context.settings, context.archive.policy) : null,
    supervisor: { kind: selection.includeMessages ? 'redacted-supervisor-messages' : 'limited-supervisor-summary', scope: 'recent in-memory app stream only; stdout, stderr and files omitted',
      included: selectedLogs.length, omitted: (context.logCount ?? logs.length) - selectedLogs.length, redacted: lines.filter((l) => l.redacted).length, partial: lines.filter((l) => l.partial).length,
      freeTextOmitted: !selection.includeMessages, lines },
    records,
  };
}
