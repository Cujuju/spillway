import { createHash } from 'node:crypto';
import type { ArchiveEntry } from '@shared/archive';
import type { PortableCapture } from '@shared/archiveExport';
import { EVAL_ASSERTION_LIMITS, EVAL_LIMITS, type EvalAnnotation, type EvalCase } from '@shared/evalCase';
import { portableCapture } from './archiveExport';

export const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max = 8192): v is string => typeof v === 'string' && v.length <= max;
const date = (v: unknown) => str(v, 64) && Number.isFinite(Date.parse(v));
const integer = (v: unknown, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;
export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const requireValid = (ok: unknown, label: string): void => { if (!ok) throw new Error(`Invalid ${label}`); };

export function validateAnnotation(v: unknown): EvalAnnotation {
  requireValid(object(v), 'case annotation'); const a = v as EvalAnnotation;
  requireValid(str(a.title, 160) && a.title.trim() && str(a.notes, 8192) && str(a.expectedOutcome, 8192), 'annotation text');
  requireValid(Array.isArray(a.assertions) && a.assertions.length <= EVAL_ASSERTION_LIMITS.count && a.assertions.every((x) => object(x) && ['contains', 'not-contains', 'equals'].includes(x.kind as string) && str(x.value, EVAL_ASSERTION_LIMITS.valueChars) && x.value.length > 0), 'literal assertions');
  requireValid(object(a.context) && str(a.context.repository, 2048) && str(a.context.revision, 128) && ['unknown', 'unavailable'].includes(a.context.workspace) && str(a.context.notes, 8192), 'context declaration');
  return { title: a.title, notes: a.notes, expectedOutcome: a.expectedOutcome, assertions: a.assertions.map((x) => ({ kind: x.kind, value: x.value })), context: { repository: a.context.repository, revision: a.context.revision, workspace: a.context.workspace, notes: a.context.notes } };
}

export function validateCapture(v: unknown): PortableCapture {
  requireValid(object(v), 'capture'); const c = v as PortableCapture, e = c.entry;
  requireValid(c.type === 'capture' && object(e) && e.schemaVersion === 1 && str(e.traceId, 128) && /^[\w-]{8,128}$/.test(e.traceId) && e.id === `trace:${e.traceId}`, 'capture identity/version');
  requireValid(date(e.at) && ['unknown', 'missing', 'pending', 'partial', 'complete', 'expired'].includes(e.state) && ['reason', 'model', 'provider', 'method', 'path'].every((k) => str(e[k as keyof ArchiveEntry])), 'capture metadata');
  requireValid(['captureId', 'captureEpoch', 'sessionId', 'client'].every((k) => e[k as keyof ArchiveEntry] === null || str(e[k as keyof ArchiveEntry])) && (e.captureSequence === null || integer(e.captureSequence)) && integer(e.status, 599) && integer(e.bytes), 'capture dimensions');
  requireValid(Array.isArray(c.attempts) && c.attempts.length <= 200 && Buffer.byteLength(JSON.stringify(c.attempts)) <= 2 * 1024 * 1024 && ['recorded', 'malformed'].includes(c.attemptsState), 'attempt links');
  requireValid(c.attemptsState !== 'malformed' || c.attempts.length === 0, 'malformed attempt state');
  const normalized = portableCapture(e, '{}', JSON.stringify(c.attempts), false);
  requireValid(normalized.attemptsState === 'recorded', 'attempt structure');
  for (const a of c.attempts) requireValid(a.provenance === null || object(a.provenance) && a.provenance.source === 'proxy', 'attempt provenance');
  const p = c.payload;
  requireValid(object(p) && ['included', 'omitted', 'unavailable', 'malformed'].includes(p.state) && p.representation === 'downstream-protocol-v1' && str(p.reason), 'payload envelope');
  if (p.state === 'included') {
    requireValid(object(p.data) && str(p.sha256, 64) && p.sha256 === sha256(JSON.stringify(p.data)), 'payload digest');
    requireValid(portableCapture({ ...e, bytes: 1 }, JSON.stringify(p.data), '[]', true).payload.state === 'included', 'protocol payload');
  } else requireValid(p.data === null && p.sha256 === null, 'absent payload');
  requireValid(Buffer.byteLength(JSON.stringify(c)) <= EVAL_LIMITS.snapshotBytes - 32 * 1024, 'capture size');
  return c;
}

export function validateCase(v: unknown): EvalCase {
  requireValid(object(v), 'case'); const c = v as EvalCase;
  requireValid(c.type === 'eval-case' && c.schemaVersion === 1 && str(c.id, 64) && /^case:[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(c.id) && integer(c.revision, EVAL_LIMITS.revisions) && c.revision >= 1 && c.parentRevision === (c.revision === 1 ? null : c.revision - 1) && date(c.createdAt) && c.taskOutcome === 'unknown', 'case identity/version');
  validateAnnotation(c.annotation); validateCapture(c.capture);
  requireValid(object(c.provenance) && ['local-archive', 'portable-import'].includes(c.provenance.source) && c.provenance.archiveId === c.capture.entry.id && (c.provenance.importedFrom === null || str(c.provenance.importedFrom, 128)), 'case provenance');
  requireValid(Array.isArray(c.missingContext) && c.missingContext.length <= 32 && c.missingContext.every((x) => str(x, 2048)), 'missing context');
  if (c.portability !== undefined) requireValid(object(c.portability) && c.portability.policy === 'credential-redaction-v1' && ['omitted', 'redacted', 'included'].includes(c.portability.protocol) && c.portability.replayFidelity === 'not-guaranteed' && (c.portability.originalPayloadSha256 === null || /^[a-f0-9]{64}$/.test(c.portability.originalPayloadSha256)), 'export transformation disclosure');
  requireValid(Buffer.byteLength(JSON.stringify(c)) <= EVAL_LIMITS.snapshotBytes, 'case size');
  return c;
}

export function missingContext(c: PortableCapture): string[] {
  const out = ['Agent harness, repository checkout/revision verification and tool environment are unavailable. Repository labels are unverified user declarations.', 'Only observed downstream protocol is retained; provider-hidden state and task outcome are unknown.'];
  if (c.entry.state !== 'complete') out.push(`Capture is ${c.entry.state}: ${c.entry.reason}`);
  if (c.payload.state !== 'included') out.push(`Protocol payload is ${c.payload.state}.`);
  if (c.attemptsState === 'malformed' || c.attempts.some((a) => !a.provenance)) out.push('Attempt provenance is incomplete or malformed.');
  return out;
}

export function encodeCaseFile(c: EvalCase): string {
  validateCase(c);
  const prefix = `${JSON.stringify({ type: 'manifest', format: 'spillway.eval-cases', version: 1, records: 1, taskOutcome: 'unknown' })}\n${JSON.stringify(c)}\n`;
  return `${prefix}${JSON.stringify({ type: 'complete', records: 1, bytesBeforeTrailer: Buffer.byteLength(prefix), sha256: sha256(prefix) })}\n`;
}

/** Validate exact bytes and the entire file before any database mutation. */
export function decodeCaseFile(bytes: Buffer): { cases: EvalCase[]; captures: PortableCapture[]; source: string } {
  requireValid(bytes.length <= EVAL_LIMITS.fileBytes && bytes.length > 0 && bytes.at(-1) === 10 && !bytes.includes(13) && !bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'UTF-8 LF file/size');
  const values: unknown[] = []; let offset = 0, trailerStart = 0;
  while (offset < bytes.length) {
    const end = bytes.indexOf(10, offset);
    requireValid(end >= offset && end - offset <= EVAL_LIMITS.snapshotBytes && values.length < EVAL_LIMITS.cases + 2, 'line size/count');
    values.push(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, end))) as unknown);
    trailerStart = offset; offset = end + 1;
  }
  requireValid(values.length >= 2, 'file lines');
  const m = values[0], t = values.at(-1);
  requireValid(object(m) && object(t), 'file envelope');
  const manifest = m as Record<string, unknown>, trailer = t as Record<string, unknown>;
  requireValid(manifest.type === 'manifest' && ['spillway.eval-cases', 'spillway.request-archive'].includes(manifest.format as string) && manifest.version === 1 && manifest.taskOutcome === 'unknown' && integer(manifest.records, EVAL_LIMITS.cases) && manifest.records === values.length - 2, 'manifest/version/count');
  const prefix = bytes.subarray(0, trailerStart);
  requireValid(trailer.type === 'complete' && trailer.records === manifest.records && trailer.bytesBeforeTrailer === prefix.length && trailer.sha256 === sha256(prefix), 'exact-byte integrity trailer');
  const cases: EvalCase[] = [], captures: PortableCapture[] = [], ids = new Set<string>();
  for (const v of values.slice(1, -1)) {
    const row = manifest.format === 'spillway.eval-cases' ? validateCase(v) : validateCapture(v);
    const key = 'capture' in row ? `${row.id}:${row.revision}` : row.entry.id;
    requireValid(!ids.has(key), 'duplicate identity'); ids.add(key);
    if ('capture' in row) cases.push(row); else captures.push(row);
  }
  if (manifest.format === 'spillway.request-archive') {
    requireValid(manifest.boundary === 'observed-downstream-only' && manifest.attemptLimit === 200 && manifest.attemptCompleteness === 'bounded-recorded-links' && ['omitted', 'included-if-recorded'].includes(manifest.rawPayloads as string), 'archive boundary');
    const counts = { included: 0, omitted: 0, unavailable: 0, malformed: 0 };
    for (const c of captures) counts[c.payload.state]++;
    requireValid(object(trailer.payloadStates) && Object.entries(counts).every(([k, n]) => (trailer.payloadStates as Record<string, unknown>)[k] === n), 'payload counts');
    requireValid(manifest.rawPayloads !== 'omitted' || counts.omitted === captures.length, 'archive omission policy');
  }
  return { cases, captures, source: sha256(bytes) };
}

/** Redacts common credential forms; arbitrary private prose still requires user review. */
export function redactExport(c: EvalCase, includeBodies: boolean, secrets: string[] = []): EvalCase {
  const scrub = (text: string): string => {
    for (const secret of secrets) if (secret.length >= 8) text = text.split(secret).join('[REDACTED]');
    return text.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[REDACTED]').replace(/\bBearer\s+[^\s"\\]+/gi, 'Bearer [REDACTED]').replace(/((?:api[_-]?key|password|secret|authorization|access[_-]?token)\s*["']?\s*[:=]\s*["']?)[^\s,"'\\}]+/gi, '$1[REDACTED]');
  };
  const walk = (v: unknown, depth = 0): unknown => {
    if (depth > 64) throw new Error('Export nesting exceeds limit');
    if (typeof v === 'string') return scrub(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (object(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /^(?:api[_-]?key|password|secret|authorization|credentials|access[_-]?token)$/i.test(k) ? '[REDACTED]' : walk(x, depth + 1)]));
    return v;
  };
  const out = walk(c) as EvalCase;
  if (!includeBodies) out.capture.payload = { state: 'omitted', reason: 'eval-export-policy', representation: 'downstream-protocol-v1', data: null, sha256: null };
  else if (out.capture.payload.data) out.capture.payload.sha256 = sha256(JSON.stringify(out.capture.payload.data));
  out.portability = { policy: 'credential-redaction-v1', protocol: out.capture.payload.data ? (c.portability?.protocol === 'redacted' || out.capture.payload.sha256 !== c.capture.payload.sha256 ? 'redacted' : 'included') : 'omitted',
    originalPayloadSha256: c.portability?.originalPayloadSha256 ?? c.capture.payload.sha256, replayFidelity: 'not-guaranteed' };
  const disclosure = 'Export redacts common credential patterns; payloads may be omitted or changed. Review prose for private material.';
  out.missingContext = [...out.missingContext.filter((reason) => reason !== disclosure).slice(0, 31), disclosure];
  return out;
}
