import { createHash, randomUUID } from 'node:crypto';
import { open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import path from 'node:path';
import { archiveCursor, type ArchiveEntry, type ArchiveQuery, type CaptureState } from '@shared/archive';
import { DEFAULT_EXPORT_LIMITS, EXPORT_PREVIEW_TTL_MS, type ExportLimits, PORTABLE_ARCHIVE_FORMAT, type ArchiveExportJob, type ArchiveExportOptions, type PortableAttempt, type PortableCapture, type PortablePayloadData, type PortableTrailer } from '@shared/archiveExport';
import type { Db } from './activityDb';
import type { ArchiveStore } from './archiveStore';
import { normalizeTransport } from '@shared/activityTransport';

const STATES: CaptureState[] = ['unknown', 'missing', 'pending', 'partial', 'complete', 'expired'];
const SNAPSHOT = 'portable_export_snapshot';
const MIB = 1024 * 1024;
/** Snapshot room for entry metadata and attempt links beyond the archive's body budget. */
const METADATA_ALLOWANCE_BYTES = 16 * MIB;
const mib = (bytes: number): string => `${bytes / MIB} MiB`;
const text = (v: unknown, max = 8192): v is string => typeof v === 'string' && v.length <= max;
const date = (v: unknown): v is string => text(v, 64) && Number.isFinite(Date.parse(v));
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function normalizeExportOptions(raw: ArchiveExportOptions): ArchiveExportOptions {
  if (!record(raw)) throw new Error('Invalid export selection');
  if (raw.includeRecordedBodies !== undefined && typeof raw.includeRecordedBodies !== 'boolean') throw new Error('Invalid payload policy');
  const query: ArchiveQuery = {};
  if (raw.query !== undefined) {
    if (!record(raw.query) || 'before' in raw.query) throw new Error('Export selects the whole filter, not a page');
    for (const k of ['text', 'sessionId', 'provider', 'model', 'client', 'state'] as const) {
      const v = raw.query[k];
      if (v === undefined || v === '') continue;
      if (!text(v, 256) || k === 'state' && !STATES.includes(v as CaptureState)) throw new Error(`Invalid export ${k}`);
      Object.assign(query, { [k]: v });
    }
    for (const k of ['from', 'to'] as const) {
      const v = raw.query[k];
      if (v === undefined || v === '') continue;
      if (!date(v)) throw new Error(`Invalid export ${k} date`);
      query[k] = new Date(v).toISOString();
    }
    if (query.from && query.to && query.from > query.to) throw new Error('Export start must be before end');
  }
  let ids: string[] | undefined;
  if (raw.ids !== undefined) {
    if (!Array.isArray(raw.ids) || !raw.ids.length || raw.ids.length > 1000 || raw.ids.some((id) => !text(id, 140) || !/^trace:[a-zA-Z0-9_-]{8,128}$/.test(id))) throw new Error('Select 1–1000 stable archive IDs');
    ids = [...new Set(raw.ids)];
  }
  return { query, ...(ids ? { ids } : {}), includeRecordedBodies: raw.includeRecordedBodies === true };
}

function payloadData(raw: string): PortablePayloadData | null {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!record(v) || !['request', 'response'].every((k) => text(v[k], 4 * 1024 * 1024)) ||
    !['requestType', 'responseType', 'requestEncoding', 'responseEncoding'].every((k) => text(v[k])) ||
    !['http', 'websocket'].includes(String(v.format)) || typeof v.requestDecoded !== 'boolean' || typeof v.responseDecoded !== 'boolean' || !Array.isArray(v.frames) || v.frames.length > 128) return null;
  for (const f of v.frames) if (!record(f) || !Number.isSafeInteger(f.index) || !['request', 'response'].includes(String(f.direction)) ||
    !date(f.at) || !['text', 'binary'].includes(String(f.type)) || typeof f.truncated !== 'boolean' || !text(f.payload, 64 * 1024 * 3)) return null;
  // Copy known fields only; stored objects must never widen the export boundary.
  return { request: v.request, response: v.response, requestType: v.requestType, responseType: v.responseType, requestEncoding: v.requestEncoding, responseEncoding: v.responseEncoding,
    format: v.format, requestDecoded: v.requestDecoded, responseDecoded: v.responseDecoded,
    frames: v.frames.map((f) => ({ index: f.index, direction: f.direction, at: f.at, type: f.type, payload: f.payload, truncated: f.truncated })) } as PortablePayloadData;
}

function attempts(raw: string): PortableAttempt[] {
  const rows = JSON.parse(raw) as unknown[];
  if (!Array.isArray(rows) || rows.length > 200) throw new Error('Malformed archived attempt links');
  return rows.map((v) => {
    if (!record(v) || !text(v.requestId, 2 * 1024 * 1024) || !date(v.at) || v.selectionId !== null && !text(v.selectionId, 2 * 1024 * 1024)) throw new Error('Malformed archived attempt link');
    let provenance: PortableAttempt['provenance'] = null;
    if (record(v.provenance)) {
      const p = v.provenance, fields: Record<string, unknown> = { source: 'proxy' };
      for (const k of ['model', 'effectiveModel', 'reasoningEffort', 'provider', 'client', 'sessionId', 'parentSessionId']) fields[k] = text(p[k], 512) ? p[k] : null;
      Object.assign(fields, normalizeTransport(p));
      for (const k of ['statusCode', 'latencyMs', 'ttftMs']) fields[k] = typeof p[k] === 'number' && Number.isFinite(p[k]) && p[k] >= 0 ? p[k] : null;
      fields.failed = typeof p.failed === 'boolean' ? p.failed : null;
      provenance = fields as unknown as NonNullable<PortableAttempt['provenance']>;
    }
    return { requestId: v.requestId, selectionId: v.selectionId, at: v.at, provenance } as PortableAttempt;
  });
}

export function portableCapture(entry: ArchiveEntry, detail: string, links: string, include: boolean): PortableCapture {
  const payload: PortableCapture['payload'] = { state: include ? 'unavailable' : 'omitted', reason: include ? entry.reason || entry.state : 'export-policy', representation: 'downstream-protocol-v1', sha256: null, data: null };
  if (include && entry.bytes > 0) {
    const data = payloadData(detail);
    if (data) { payload.state = 'included'; payload.reason = entry.reason; payload.data = data; payload.sha256 = createHash('sha256').update(JSON.stringify(data), 'utf8').digest('hex'); }
    else { payload.state = 'malformed'; payload.reason = 'invalid-stored-detail'; }
  }
  let linksState: PortableCapture['attemptsState'] = 'recorded', parsed: PortableAttempt[] = [];
  try { parsed = attempts(links); } catch { linksState = 'malformed'; }
  return { type: 'capture', entry, attempts: parsed, attemptsState: linksState, payload };
}

/** Runs only in the Activity worker, using its existing encrypted connection. */
export class ArchiveExporter {
  private current: ArchiveExportJob | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private canceled = false;
  private initialized = false;
  cleanupWarning: string | null = null;
  constructor(private db: Db, private archive: ArchiveStore, private limits: ExportLimits = DEFAULT_EXPORT_LIMITS) {
    this.initialize();
  }
  private initialize(): void {
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${SNAPSHOT} (ordinal INTEGER PRIMARY KEY, entry TEXT NOT NULL, detail TEXT NOT NULL, attempts TEXT NOT NULL); DELETE FROM ${SNAPSHOT};`);
      this.db.exec('CREATE TABLE IF NOT EXISTS portable_export_temp (path TEXT PRIMARY KEY)');
      this.initialized = true;
      this.recoverIncomplete();
    } catch (error) { this.cleanupWarning = `Portable export initialization failed: ${String(error)}`; }
  }
  private recoverIncomplete(): void {
    const warnings: string[] = [];
    try {
      for (const r of this.db.prepare('SELECT path FROM portable_export_temp').all() as { path: string }[]) {
        try {
          if (!path.isAbsolute(r.path) || !/^\.spillway-export-[a-f0-9-]{36}\.partial$/.test(path.basename(r.path))) throw new Error('Invalid incomplete export path');
          try { unlinkSync(r.path); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          this.db.prepare('DELETE FROM portable_export_temp WHERE path=?').run(r.path);
        } catch (error) { if (warnings.length < 8) warnings.push(`Could not clean incomplete export ${r.path}: ${String(error)}`); }
      }
    } catch (error) { warnings.push(`Could not read incomplete export markers: ${String(error)}`); }
    this.cleanupWarning = warnings.length ? warnings.join('\n') : null;
  }
  private cleanupProblem(job: ArchiveExportJob, warning: string): void {
    job.warning = job.warning ? `${job.warning}\n${warning}` : warning;
    this.cleanupWarning = job.warning;
  }
  private requireReady(): void {
    if (!this.initialized) this.initialize();
    if (!this.initialized) throw new Error(this.cleanupWarning ?? 'Portable export is unavailable');
    this.recoverIncomplete();
    if (this.cleanupWarning) throw new Error(`${this.cleanupWarning}\nResolve incomplete-file cleanup before exporting again.`);
  }
  prepare(raw: ArchiveExportOptions): ArchiveExportJob {
    const selection = normalizeExportOptions(raw);
    if (this.running) throw new Error('Cancel or finish the current export first');
    this.requireReady();
    this.discard(); this.current = null;
    this.archive.prune();
    const status = this.archive.status(), now = Date.now();
    const states = Object.fromEntries(STATES.map((s) => [s, 0])) as Record<CaptureState, number>;
    const wanted = selection.ids ? new Set(selection.ids) : null, found = new Set<string>();
    let count = 0, bytes = 0;
    const { recordBytes, snapshotBytes, records } = this.limits;
    const limit = Math.min(snapshotBytes, status.policy.maxBytes + METADATA_ALLOWANCE_BYTES);
    this.db.transaction(() => {
      let before: string | undefined;
      for (;;) {
        const page = this.archive.query({ ...selection.query, before }, false);
        for (const e of page.entries) {
          if (wanted && !wanted.has(e.id)) continue;
          const meta = JSON.stringify(e);
          const linkSize = (this.db.prepare('SELECT coalesce(sum(length(CAST(detail AS BLOB))),0) AS n FROM archive_attempts WHERE trace_id=?').get(e.traceId) as { n: number }).n;
          if (linkSize > 2 * 1024 * 1024) throw new Error('Archived attempt metadata exceeds export limit');
          const links = (this.db.prepare('SELECT detail FROM archive_attempts WHERE trace_id=? ORDER BY identity LIMIT 200').all(e.traceId) as { detail: string }[]).map((a) => a.detail);
          const joined = `[${links.join(',')}]`;
          const body = selection.includeRecordedBodies && e.bytes > 0;
          const size = (this.db.prepare('SELECT length(CAST(detail AS BLOB)) AS n FROM archive_entries WHERE id=?').get(e.id) as { n: number }).n;
          const added = Buffer.byteLength(meta) + Buffer.byteLength(joined) + (body ? size : 2);
          if (body && size > recordBytes || added > recordBytes) throw new Error(`Archived record exceeds the ${mib(recordBytes)} export limit`);
          if (++count > records || bytes + added > limit) throw new Error(`Export snapshot limit reached (up to ${mib(snapshotBytes)} / ${records.toLocaleString('en-US')} records). Select a smaller date range or omit bodies.`);
          bytes += added; states[e.state]++; found.add(e.id);
          this.db.prepare(`INSERT INTO ${SNAPSHOT} SELECT ?,?,CASE WHEN ? THEN detail ELSE '{}' END,? FROM archive_entries WHERE id=?`).run(count, meta, body ? 1 : 0, joined, e.id);
        }
        if (!page.more) break;
        before = archiveCursor(page.entries.at(-1)!);
      }
    })();
    const { epoch, sequence, dropped, gaps, restarts, rejected } = status;
    const id = randomUUID();
    this.current = { id, state: 'preview', writtenRecords: 0, writtenBytes: 0, path: null, error: null, warning: null, manifest: {
      type: 'manifest', format: PORTABLE_ARCHIVE_FORMAT, version: 1, id, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + EXPORT_PREVIEW_TTL_MS).toISOString(),
      selection, unresolvedIds: selection.ids?.filter((key) => !found.has(key)) ?? [], records: count, snapshotBytes: bytes, captureStates: states, recordingPolicy: { ...status.policy },
      captureDiagnostics: { epoch, sequence, dropped, gaps, restarts, rejected }, boundary: 'observed-downstream-only', taskOutcome: 'unknown', rawPayloads: selection.includeRecordedBodies ? 'included-if-recorded' : 'omitted',
      attemptLimit: 200, attemptCompleteness: 'bounded-recorded-links',
    } };
    this.canceled = false;
    this.timer = setTimeout(() => { this.cancel(id, true); }, EXPORT_PREVIEW_TTL_MS); this.timer.unref();
    return this.status(id);
  }
  status(id: string): ArchiveExportJob {
    if (!this.current || this.current.id !== id) throw new Error('Export preview is no longer available');
    return structuredClone(this.current);
  }
  start(id: string, destination: string): ArchiveExportJob {
    const job = this.current;
    if (!job || job.id !== id || job.state !== 'preview') throw new Error('Prepare a fresh export preview');
    if (!path.isAbsolute(destination)) throw new Error('Export destination must be absolute');
    if (Date.now() >= Date.parse(job.manifest.expiresAt)) { this.cancel(id, true); return this.status(id); }
    job.state = 'writing';
    this.running = this.write(job, destination).finally(() => { this.running = null; });
    return this.status(id);
  }
  cancel(id: string, expired = false): ArchiveExportJob {
    this.status(id);
    const job = this.current!;
    if (job.state === 'preview' || job.state === 'writing') {
      this.canceled = true; job.state = expired ? 'expired' : 'canceled';
      if (!this.running) {
        try { this.discard(); }
        catch (error) { this.cleanupProblem(job, `Could not clean encrypted snapshot: ${String(error)}`); }
      }
    }
    return this.status(id);
  }
  async dispose(): Promise<void> {
    if (this.current) this.cancel(this.current.id);
    await this.running;
    try { this.discard(); }
    catch (error) {
      const warning = `Could not clean encrypted snapshot: ${String(error)}`;
      if (this.current) this.cleanupProblem(this.current, warning); else this.cleanupWarning = warning;
    }
  }
  cancelCurrent(): void { if (this.current) this.cancel(this.current.id); }
  private discard(): void {
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    if (this.initialized) this.db.exec(`DELETE FROM ${SNAPSHOT}`);
  }
  private async write(job: ArchiveExportJob, destination: string): Promise<void> {
    const temp = path.join(path.dirname(destination), `.spillway-export-${job.id}.partial`);
    let file: FileHandle | null = null, ownsTemp = false;
    const hash = createHash('sha256');
    const check = () => { if (this.canceled || Date.now() >= Date.parse(job.manifest.expiresAt)) throw new Error('Export canceled or expired'); };
    const emit = async (value: unknown, digest = true) => {
      const line = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
      if (line.length > this.limits.recordBytes) throw new Error(`Encoded export record exceeds ${mib(this.limits.recordBytes)}`);
      for (let offset = 0; offset < line.length;) {
        check(); const { bytesWritten } = await file!.write(line, offset, Math.min(64 * 1024, line.length - offset));
        if (!bytesWritten) throw new Error('Export disk write made no progress');
        if (digest) hash.update(line.subarray(offset, offset + bytesWritten));
        offset += bytesWritten; job.writtenBytes += bytesWritten;
      }
    };
    try {
      check(); this.db.prepare('INSERT INTO portable_export_temp VALUES(?)').run(temp);
      file = await open(temp, 'wx', 0o600); ownsTemp = true;
      await emit(job.manifest);
      const payloadStates: PortableTrailer['payloadStates'] = { included: 0, omitted: 0, unavailable: 0, malformed: 0 };
      for (let ordinal = 1; ordinal <= job.manifest.records; ordinal++) {
        check();
        const row = this.db.prepare(`SELECT entry,detail,attempts FROM ${SNAPSHOT} WHERE ordinal=?`).get(ordinal) as { entry: string; detail: string; attempts: string } | undefined;
        if (!row) throw new Error('Export snapshot record missing');
        const capture = portableCapture(JSON.parse(row.entry) as ArchiveEntry, row.detail, row.attempts, job.manifest.selection.includeRecordedBodies === true);
        await emit(capture); payloadStates[capture.payload.state]++; job.writtenRecords++;
      }
      await emit({ type: 'complete', records: job.writtenRecords, bytesBeforeTrailer: job.writtenBytes, sha256: hash.digest('hex'), payloadStates } satisfies PortableTrailer, false);
      check(); await file.sync(); await file.close(); file = null; check();
      job.state = 'finalizing'; await rename(temp, destination); ownsTemp = false;
      job.path = destination; job.state = 'complete';
    } catch (error) {
      if (job.state !== 'canceled' && job.state !== 'expired') { job.state = 'failed'; job.error = error instanceof Error ? error.message : String(error); }
    } finally {
      try { if (file) await file.close(); }
      catch (error) { this.cleanupProblem(job, `Could not close export: ${String(error)}`); }
      try { if (ownsTemp) { await unlink(temp); ownsTemp = false; } }
      catch (error) { this.cleanupProblem(job, `Could not remove incomplete export ${temp}: ${String(error)}`); }
      try { if (!ownsTemp) this.db.prepare('DELETE FROM portable_export_temp WHERE path=?').run(temp); this.discard(); }
      catch (error) { this.cleanupProblem(job, `Could not clean encrypted snapshot: ${String(error)}`); }
    }
  }
}
