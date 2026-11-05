import type { Db } from './activityDb';
import { normalizeTransport } from '@shared/activityTransport';
import { tokenCost, type TokenCounts } from '@shared/modelPrices';
import { TRACE_ATTEMPT_PAGE_SIZE, TRACE_PAGE_SIZE, TRACE_SCAN_LIMIT, traceNodeId, type TraceAttempt, type TraceAttemptPage, type TraceAttemptQuery, type TraceCoverage, type TracePage, type TraceQuery, type TraceRange } from '@shared/sessionTrace';
import { traceNodes } from './traceGraph';

const REQUEST_IDENTITY = `CASE WHEN json_extract(event,'$.source')='client-log' THEN 'client-log:'||json_extract(event,'$.requestId') ELSE 'proxy:'||json_extract(event,'$.requestId')||':'||coalesce(json_extract(event,'$.authIndex'),'')||':'||json_extract(event,'$.at') END`;
const ARCHIVE_IDENTITY = `CASE WHEN json_valid(identity) AND json_array_length(identity)=3 THEN 'proxy:'||json_extract(identity,'$[0]')||':'||coalesce(json_extract(identity,'$[2]'),'')||':'||json_extract(identity,'$[1]') ELSE 'archive:'||identity END`;
const ARCHIVE_DETAIL = "CASE WHEN json_valid(detail) THEN detail ELSE '{}' END";
export const TRACE_SCHEMA = `
CREATE INDEX IF NOT EXISTS requests_trace_identity ON requests (${REQUEST_IDENTITY});
CREATE INDEX IF NOT EXISTS requests_trace_time ON requests (json_extract(event,'$.at'), ${REQUEST_IDENTITY});
CREATE INDEX IF NOT EXISTS requests_trace_session ON requests (json_extract(event,'$.sessionId'), json_extract(event,'$.at'), ${REQUEST_IDENTITY});
CREATE INDEX IF NOT EXISTS archive_attempt_time ON archive_attempts (json_extract(${ARCHIVE_DETAIL},'$.at'), ${ARCHIVE_IDENTITY});
CREATE INDEX IF NOT EXISTS archive_attempt_session ON archive_attempts (json_extract(${ARCHIVE_DETAIL},'$.provenance.sessionId'), json_extract(${ARCHIVE_DETAIL},'$.at'), ${ARCHIVE_IDENTITY});
`;
type Raw = { id: string; at: string; origin: 'activity' | 'archive'; event: string; accounting: string | null;
  trace_id: string | null; capture_state: TraceAttempt['captureState'] | null; capture_reason: string | null; path: string | null; identity: string | null };
const DAY = 86_400_000;
const TEXT_FIELDS = ['source', 'sessionId', 'parentSessionId', 'model', 'effectiveModel', 'reasoningEffort', 'provider', 'client', 'downstreamTransport', 'upstreamTransport', 'transportFallbackReason'];
function metadata(column: string, archive: boolean): string {
  const strings = (fields: string[]) => fields.flatMap((k) => [`'${k}'`, `CASE WHEN json_type(${column},'$.${k}')='text' THEN substr(json_extract(${column},'$.${k}'),1,513) END`]);
  const numbers = (fields: string[]) => fields.flatMap((k) => [`'${k}'`, `CASE ${k === 'cacheWriteTokens' ? `WHEN json_type(${column},'$.${k}') IS NULL OR json_type(${column},'$.${k}')='null' THEN 0 ` : ''}WHEN json_type(${column},'$.${k}') IN ('integer','real') THEN json_extract(${column},'$.${k}') END`]);
  const values = [...strings(archive ? ['at', 'requestId', 'selectionId'] : [...TEXT_FIELDS, 'at', 'requestId', 'selectionId', 'authIndex', 'movedFrom']),
    ...numbers(archive ? [] : ['statusCode', 'latencyMs', 'ttftMs', 'inputTokens', 'outputTokens', 'cachedTokens', 'cacheWriteTokens'])];
  const failure = (col: string) => `json(CASE json_type(${col},'$.failed') WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' ELSE 'null' END)`;
  if (archive) values.push("'provenance'", metadata(`${column} -> '$.provenance'`, false));
  else values.push("'failed'", failure(column));
  return `json_object(${values.join(',')})`;
}
const text = (v: unknown): string | null => typeof v === 'string' && v.length > 0 && Array.from(v).length <= 512 ? v : null;
const number = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const date = (v: unknown): v is string => typeof v === 'string' && v.length <= 32 && Number.isFinite(Date.parse(v));
function object(raw: string | null): Record<string, unknown> {
  try { const v: unknown = JSON.parse(raw ?? '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}; }
  catch { return {}; }
}
function observation(r: Raw): TraceAttempt | null {
  const e = object(r.event);
  if (!text(e.requestId) || !date(e.at) || e.at !== r.at) return null;
  let p = e;
  if (r.origin === 'archive') {
    const provenance = e.provenance;
    p = provenance && typeof provenance === 'object' && !Array.isArray(provenance) ? provenance as Record<string, unknown> : {};
    // Only the supported proxy provenance shape can assert session/parent/transport observations.
    if (p.source !== 'proxy') p = {};
    try {
      const identity: unknown = JSON.parse(r.identity ?? 'null');
      if (!Array.isArray(identity) || identity.length !== 3 || identity[0] !== e.requestId || identity[1] !== e.at || !(identity[2] === null || text(identity[2]))) return null;
    } catch { return null; }
  }
  const source = r.origin === 'archive' || e.source !== 'client-log' ? 'proxy' : 'client-log';
  const keys = ['inputTokens', 'outputTokens', 'cachedTokens', 'cacheWriteTokens'] as const;
  const tokens = r.origin === 'activity' && keys.every((k) => number(e[k]) !== null)
    ? Object.fromEntries(keys.map((k) => [k, e[k]])) as unknown as TokenCounts : null;
  const model = text(p.model), effectiveModel = text(p.effectiveModel), provider = text(p.provider);
  const recordedCost = number(object(r.accounting).costUsd);
  const price = tokens ? tokenCost(provider ?? '', effectiveModel ?? model ?? '', tokens) : null;
  // The ledger also stores zero for unpriced models; that zero is not a known price.
  const priceKnown = price ?? tokenCost(provider ?? '', effectiveModel ?? model ?? '', { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 });
  const costUsd = r.origin === 'activity' && recordedCost !== null && (recordedCost > 0 || priceKnown) ? recordedCost : price?.usd ?? null;
  return { id: r.id, at: new Date(r.at).toISOString(), requestId: text(e.requestId)!, selectionId: text(e.selectionId),
    traceId: text(r.trace_id), origin: r.origin, source, sessionId: text(p.sessionId), parentSessionId: text(p.parentSessionId),
    model, effectiveModel, reasoningEffort: text(p.reasoningEffort), provider, client: text(p.client),
    authIndex: r.origin === 'activity' ? text(e.authIndex) : null, movedFrom: r.origin === 'activity' ? text(e.movedFrom) : null,
    failed: typeof p.failed === 'boolean' ? p.failed : null, statusCode: number(p.statusCode),
    latencyMs: source === 'proxy' ? number(p.latencyMs) : null, ttftMs: source === 'proxy' ? number(p.ttftMs) : null,
    tokens, costUsd, ...normalizeTransport(p), captureState: r.capture_state ?? 'unknown', captureReason: r.capture_reason ?? '',
    compactionEndpoint: /(?:^|\/)responses\/compact\/?$/.test(r.path ?? '') };
}
function range(q: TraceRange, now = Date.now()): Required<TraceRange> {
  if (q.from !== undefined && !date(q.from) || q.to !== undefined && !date(q.to)) throw new Error('Invalid trace date range');
  const to = new Date(q.to ?? now).toISOString();
  const from = new Date(q.from ?? Date.parse(to) - 7 * DAY).toISOString();
  if (from > to || Date.parse(to) - Date.parse(from) > 90 * DAY) throw new Error('Trace range must be at most 90 days');
  return { from, to, source: q.source === 'all' ? 'all' : 'proxy' };
}
function nodeFilter(nodeId: string | undefined, origin: 'activity' | 'archive'): { sql: string; args: string[] } | null {
  if (!nodeId) return null;
  if (typeof nodeId !== 'string' || nodeId.length > 2_000) throw new Error('Invalid trace node');
  const prefix = origin === 'activity' ? '' : 'provenance.';
  const column = origin === 'activity' ? 'event' : ARCHIVE_DETAIL;
  const session = `json_extract(${column},'$.${prefix}sessionId')`;
  const normalized = `CASE WHEN json_type(${column},'$.${prefix}sessionId')='text' AND length(${session}) BETWEEN 1 AND 512 ${origin === 'archive' ? `AND json_extract(${ARCHIVE_DETAIL},'$.provenance.source')='proxy'` : ''} THEN ${session} END`;
  if (nodeId.startsWith('session:')) return { sql: `${session}=? AND (${normalized}) IS NOT NULL`, args: [nodeId.slice(8)] };
  if (nodeId.startsWith('trace:')) return { sql: `${origin === 'activity' ? "json_extract(event,'$.traceId')" : 'trace_id'}=? AND (${normalized}) IS NULL`, args: [nodeId.slice(6)] };
  if (nodeId.startsWith('attempt:')) return { sql: `${origin === 'activity' ? REQUEST_IDENTITY : ARCHIVE_IDENTITY}=?`, args: [nodeId.slice(8)] };
  throw new Error('Invalid trace node');
}
type Cursor = { range: Required<TraceRange>; key: string; after: [number | string, string] };
function cursor(raw: unknown): Cursor | null {
  if (raw === undefined || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > 16_384) throw new Error('Invalid trace cursor');
  try {
    const c = JSON.parse(raw) as Cursor;
    if (!c || typeof c.key !== 'string' || !c.range || !date(c.range.from) || !date(c.range.to) || !Array.isArray(c.after) || c.after.length !== 2 || typeof c.after[1] !== 'string' || !(typeof c.after[0] === 'string' || typeof c.after[0] === 'number' && Number.isFinite(c.after[0]))) throw new Error();
    return c;
  } catch { throw new Error('Invalid trace cursor'); }
}

/** Queries run only on the Activity worker's keyed connection. No bodies, file imports, or new recording path. */
export class TraceStore {
  constructor(private db: Db) {}
  private read(q: TraceQuery, bounds: Required<TraceRange>, limit: number, after?: [number | string, string]): Raw[] {
    const select = (origin: 'activity' | 'archive') => {
      const activity = origin === 'activity', col = activity ? 'event' : ARCHIVE_DETAIL;
      const id = activity ? REQUEST_IDENTITY : ARCHIVE_IDENTITY;
      const clauses = [`json_extract(${col},'$.at')>=?`, `json_extract(${col},'$.at')<=?`];
      const args: (string | number)[] = [bounds.from, bounds.to];
      if (activity && bounds.source === 'proxy') clauses.push("coalesce(json_extract(event,'$.source'),'proxy')='proxy'");
      const node = nodeFilter(q.nodeId, origin);
      if (node) { clauses.push(node.sql); args.push(...node.args); }
      if (after) { clauses.push(`(json_extract(${col},'$.at'),${id})<(?,?)`); args.push(...after); }
      if (!activity) clauses.push(`NOT EXISTS (SELECT 1 FROM requests WHERE ${REQUEST_IDENTITY}=(${ARCHIVE_IDENTITY.replaceAll('identity', 'aa.identity')}))`);
      const rows = activity
        ? `SELECT substr(${id},1,2049) AS id,substr(json_extract(event,'$.at'),1,513) AS at,'activity' AS origin,${metadata('event', false)} AS event,
            (SELECT u.event FROM usage_identities u WHERE u.key=(${id.replaceAll('event', 'requests.event')})) AS accounting,
            json_extract(event,'$.traceId') AS trace_id,NULL AS identity,
            (SELECT state FROM archive_entries a WHERE a.trace_id=json_extract(event,'$.traceId')) AS capture_state,
            (SELECT reason FROM archive_entries a WHERE a.trace_id=json_extract(event,'$.traceId')) AS capture_reason,
            (SELECT path FROM archive_entries a WHERE a.trace_id=json_extract(event,'$.traceId')) AS path FROM requests`
        : `SELECT substr(${id},1,2049) AS id,substr(json_extract(${ARCHIVE_DETAIL},'$.at'),1,513) AS at,'archive' AS origin,${metadata(ARCHIVE_DETAIL, true)} AS event,NULL AS accounting,trace_id,substr(identity,1,8193) AS identity,
            (SELECT state FROM archive_entries a WHERE a.trace_id=aa.trace_id) AS capture_state,
            (SELECT reason FROM archive_entries a WHERE a.trace_id=aa.trace_id) AS capture_reason,
            (SELECT path FROM archive_entries a WHERE a.trace_id=aa.trace_id) AS path FROM archive_attempts aa`;
      return this.db.prepare(`${rows} WHERE ${clauses.join(' AND ')} ORDER BY json_extract(${col},'$.at') DESC,${id} DESC LIMIT ?`).all(...args, limit) as Raw[];
    };
    return [...select('activity'), ...select('archive')].sort((a, b) => a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0).slice(0, limit);
  }
  query(q: TraceQuery = {}): TracePage {
    for (const [v, max] of [[q.parentSessionId, 512], [q.text, 256]] as const) if (v !== undefined && (typeof v !== 'string' || v.length > max)) throw new Error('Invalid trace filter');
    const c = cursor(q.before), bounds = range({ from: q.from ?? c?.range.from, to: q.to ?? c?.range.to, source: q.source ?? c?.range.source });
    const sort = q.sort === 'failed' || q.sort === 'recent' ? q.sort : 'cost';
    const key = JSON.stringify([bounds, sort, q.nodeId ?? '', q.parentSessionId ?? '', q.text ?? '']);
    if (c && (c.key !== key || (sort === 'recent' ? !date(c.after[0]) : typeof c.after[0] !== 'number'))) throw new Error('Trace cursor does not match query');
    const raw = this.read(q, bounds, TRACE_SCAN_LIMIT + 1), limited = raw.length > TRACE_SCAN_LIMIT;
    const observations = raw.slice(0, TRACE_SCAN_LIMIT).map(observation);
    const coverage: TraceCoverage = { ...bounds, scanned: observations.length, limit: TRACE_SCAN_LIMIT, limited, rejected: observations.filter((a) => !a).length };
    const needle = (typeof q.text === 'string' ? q.text.slice(0, 256) : '').toLowerCase();
    const children = new Set(observations.filter((a) => a?.parentSessionId === q.parentSessionId && a?.sessionId).map((a) => a!.sessionId));
    const score = (n: ReturnType<typeof traceNodes>[number]): number | string => sort === 'recent' ? n.lastAt : sort === 'failed' ? n.metrics.failed : n.metrics.costUsd ?? -1;
    const nodes = traceNodes(observations.filter((a): a is TraceAttempt => a !== null))
      .filter((n) => !q.nodeId || n.id === q.nodeId)
      .filter((n) => !q.parentSessionId || children.has(n.sessionId))
      .filter((n) => !needle || [n.id, ...n.models, ...n.efforts].some((s) => s.toLowerCase().includes(needle)))
      .sort((a, b) => score(a) < score(b) ? 1 : score(a) > score(b) ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
      .filter((n) => !c || score(n) < c.after[0] || score(n) === c.after[0] && n.id < c.after[1]);
    const page = nodes.slice(0, TRACE_PAGE_SIZE), last = page.at(-1), more = nodes.length > TRACE_PAGE_SIZE;
    return { nodes: page, more, next: more && last ? JSON.stringify({ range: bounds, key, after: [score(last), last.id] }) : null, coverage };
  }
  attempts(q: TraceAttemptQuery | undefined): TraceAttemptPage {
    if (!q || typeof q !== 'object' || typeof q.nodeId !== 'string' || !q.nodeId) throw new Error('Trace node is required');
    const c = cursor(q.before), bounds = range({ from: q.from ?? c?.range.from, to: q.to ?? c?.range.to, source: q.source ?? c?.range.source });
    const key = JSON.stringify([bounds, q.nodeId]);
    if (c && (c.key !== key || !date(c.after[0]))) throw new Error('Trace cursor does not match query');
    const rows = this.read(q, bounds, TRACE_ATTEMPT_PAGE_SIZE + 1, c?.after);
    const attempts = rows.slice(0, TRACE_ATTEMPT_PAGE_SIZE).map(observation).filter((a): a is TraceAttempt => a !== null && traceNodeId(a) === q.nodeId);
    const last = rows.slice(0, TRACE_ATTEMPT_PAGE_SIZE).at(-1), more = rows.length > TRACE_ATTEMPT_PAGE_SIZE;
    return { attempts, more, next: more && last ? JSON.stringify({ range: bounds, key, after: [last.at, last.id] }) : null, from: bounds.from, to: bounds.to };
  }
}
