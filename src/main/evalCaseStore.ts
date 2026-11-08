import { collectPieces, rebuild, type PieceDetail } from './archivePieces';
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { EVAL_LIMITS, type EvalAnnotation, type EvalCase, type EvalCaseSummary } from '@shared/evalCase';
import type { PortableCapture } from '@shared/archiveExport';
import type { Db } from './activityDb';
import type { ArchiveStore } from './archiveStore';
import { portableCapture } from './archiveExport';
import { decodeCaseFile, encodeCaseFile, missingContext, redactExport, sha256, validateAnnotation, validateCase } from './evalCaseCodec';

export const EVAL_SCHEMA = `CREATE TABLE IF NOT EXISTS eval_cases (
 id TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, title TEXT NOT NULL,
 bytes INTEGER NOT NULL, snapshot TEXT NOT NULL, operation TEXT UNIQUE, PRIMARY KEY(id,revision)
);`;

/** All cases are pinned snapshots: quotas reject additions, never silently evict cases. */
export class EvalCaseStore {
  constructor(private db: Db, private archive: ArchiveStore) {}
  list(): EvalCaseSummary[] {
    return this.db.prepare(`SELECT id,revision,title,created_at AS createdAt,bytes FROM eval_cases e
      WHERE revision=(SELECT max(revision) FROM eval_cases WHERE id=e.id) ORDER BY created_at DESC,id LIMIT 200`).all() as EvalCaseSummary[];
  }
  get(id: string, revision?: number): EvalCase {
    const row = this.db.prepare('SELECT snapshot FROM eval_cases WHERE id=? AND (? IS NULL OR revision=?) ORDER BY revision DESC LIMIT 1').get(id, revision ?? null, revision ?? null) as { snapshot: string } | undefined;
    if (!row) throw new Error('Eval case revision not found');
    return this.decode(row.snapshot);
  }
  private decode(snapshot: string): EvalCase {
    const saved = JSON.parse(snapshot);
    if (saved.pieceRefs) {
      saved.capture.payload.data = portableCapture(saved.capture.entry, JSON.stringify(rebuild(this.db, saved.pieceRefs)), '[]', true).payload.data;
      delete saved.pieceRefs;
    }
    return saved as EvalCase;
  }
  private insert(c: EvalCase, operation: string | null): void {
    validateCase(c);
    let snapshot = JSON.stringify(c); const bytes = Buffer.byteLength(snapshot);
    const existing = this.db.prepare('SELECT snapshot FROM eval_cases WHERE id=? AND revision=?').get(c.id, c.revision) as { snapshot: string } | undefined;
    if (existing) { if (JSON.stringify(this.decode(existing.snapshot)) !== snapshot) throw new Error('Case identity/revision conflicts with an existing immutable snapshot'); return; }
    const latest = this.db.prepare('SELECT snapshot FROM eval_cases WHERE id=? ORDER BY revision DESC LIMIT 1').get(c.id) as { snapshot: string } | undefined;
    if (latest) {
      const parent = this.decode(latest.snapshot);
      if (c.revision !== parent.revision + 1 || JSON.stringify(c.capture) !== JSON.stringify(parent.capture) || c.provenance.archiveId !== parent.provenance.archiveId) throw new Error('Case revision conflicts with the existing immutable capture or revision sequence');
    }
    const totals = this.db.prepare('SELECT coalesce(sum(bytes),0) AS bytes,count(DISTINCT id) AS cases FROM eval_cases').get() as { bytes: number; cases: number };
    const family = this.db.prepare('SELECT coalesce(sum(bytes),0) AS bytes,count(*) AS revisions FROM eval_cases WHERE id=?').get(c.id) as { bytes: number; revisions: number };
    if (totals.bytes + bytes > EVAL_LIMITS.totalBytes || family.bytes + bytes > EVAL_LIMITS.caseBytes || family.revisions >= EVAL_LIMITS.revisions || !family.revisions && totals.cases >= EVAL_LIMITS.cases) throw new Error('Pinned eval storage limit reached. Delete cases explicitly before adding more.');
    if (c.provenance.source === 'local-archive' && c.capture.payload.state === 'included') {
      const previous = this.db.prepare('SELECT snapshot FROM eval_cases WHERE id=? ORDER BY revision DESC LIMIT 1').get(c.id) as { snapshot: string } | undefined;
      const row = this.db.prepare('SELECT detail FROM archive_entries WHERE id=? AND bytes>0').get(c.provenance.archiveId) as { detail: string } | undefined;
      const refs: PieceDetail | undefined = previous ? JSON.parse(previous.snapshot).pieceRefs : row ? JSON.parse(row.detail) : undefined;
      let matches = false;
      if (refs) {
        try {
          const payload = portableCapture(c.capture.entry, JSON.stringify(rebuild(this.db, refs)), '[]', true).payload;
          matches = payload.sha256 === c.capture.payload.sha256;
        } catch { /* Unavailable pieces retain the inline snapshot. */ }
      }
      if (refs && matches) {
        snapshot = JSON.stringify({ ...c, capture: { ...c.capture, payload: { ...c.capture.payload, data: null } }, pieceRefs: refs });
        for (const [id] of [...refs.request, ...refs.response, ...refs.frames]) this.db.prepare('INSERT OR IGNORE INTO archive_pins VALUES(?,?)').run(id, c.id);
      }
    }
    this.db.prepare('INSERT INTO eval_cases VALUES(?,?,?,?,?,?,?)').run(c.id, c.revision, c.createdAt, c.annotation.title, bytes, snapshot, operation);
  }
  private repeated(operation: string): EvalCase | null {
    if (!/^[a-f0-9-]{36}$/.test(operation)) throw new Error('Invalid case operation identity');
    const row = this.db.prepare('SELECT snapshot FROM eval_cases WHERE operation=?').get(operation) as { snapshot: string } | undefined;
    return row ? this.decode(row.snapshot) : null;
  }
  create(operation: string, traceId: string, annotation: EvalAnnotation, includeBodies: boolean): EvalCase {
    return this.db.transaction(() => {
      const repeated = this.repeated(operation); if (repeated) return repeated;
      const d = this.archive.detail(traceId); if (!d) throw new Error('Selected archive identity is no longer available');
      const { request, response, requestType, responseType, requestEncoding, responseEncoding, format, requestDecoded, responseDecoded, frames, attempts, ...entry } = d;
      const capture = portableCapture(entry, JSON.stringify({ request, response, requestType, responseType, requestEncoding, responseEncoding, format, requestDecoded, responseDecoded, frames }), JSON.stringify(attempts), includeBodies === true);
      const c = this.fromCapture(capture, validateAnnotation(annotation), null, `case:${operation}`);
      this.insert(c, operation); return c;
    })();
  }
  private fromCapture(capture: PortableCapture, annotation: EvalAnnotation, source: string | null, id = `case:${randomUUID()}`): EvalCase {
    return { type: 'eval-case', schemaVersion: 1, id, revision: 1, parentRevision: null, createdAt: source ? capture.entry.at : new Date().toISOString(), annotation, capture,
      provenance: { source: source ? 'portable-import' : 'local-archive', archiveId: capture.entry.id, importedFrom: source }, missingContext: missingContext(capture), taskOutcome: 'unknown' };
  }
  revise(operation: string, id: string, expectedRevision: number, annotation: EvalAnnotation): EvalCase {
    return this.db.transaction(() => {
      const repeated = this.repeated(operation); if (repeated) return repeated;
      const old = this.get(id); if (old.revision !== expectedRevision) throw new Error('Case changed; reload before creating a revision');
      const c: EvalCase = { ...old, revision: old.revision + 1, parentRevision: old.revision, createdAt: new Date().toISOString(), annotation: validateAnnotation(annotation) };
      this.insert(c, operation); return c;
    })();
  }
  delete(id: string): void { this.db.transaction(() => { this.db.prepare('DELETE FROM eval_cases WHERE id=?').run(id); this.db.prepare('DELETE FROM archive_pins WHERE case_id=?').run(id); collectPieces(this.db); })(); }
  clear(): void { this.db.transaction(() => { this.db.exec('DELETE FROM eval_cases; DELETE FROM archive_pins'); collectPieces(this.db); })(); }
  export(id: string, revision: number, includeBodies: boolean): string { return encodeCaseFile(redactExport(this.get(id, revision), includeBodies === true)); }
  import(bytes: Buffer): EvalCaseSummary[] {
    const parsed = decodeCaseFile(bytes);
    const imported = parsed.cases.length ? parsed.cases.map((c): EvalCase => ({ ...c, provenance: { ...c.provenance, source: 'portable-import', archiveId: c.capture.entry.id, importedFrom: c.provenance.importedFrom ?? parsed.source } })) : parsed.captures.map((capture) => this.fromCapture(capture, { title: `Imported ${capture.entry.traceId}`, notes: '', expectedOutcome: '', assertions: [], context: { repository: '', revision: '', workspace: 'unknown', notes: '' } }, parsed.source,
      `case:${parsed.source.slice(0, 8)}-${parsed.source.slice(8, 12)}-${parsed.source.slice(12, 16)}-${parsed.source.slice(16, 20)}-${createStableSuffix(parsed.source, capture.entry.id)}`));
    this.db.transaction(() => { for (const c of [...imported].sort((a, b) => a.id.localeCompare(b.id) || a.revision - b.revision)) this.insert(c, null); })();
    return imported.map((c) => ({ id: c.id, revision: c.revision, title: c.annotation.title, createdAt: c.createdAt, bytes: Buffer.byteLength(JSON.stringify(c)) }));
  }
  async importFile(file: string): Promise<EvalCaseSummary[]> {
    const handle = await open(file, 'r');
    try {
      const stat = await handle.stat(); if (!stat.isFile() || stat.size > EVAL_LIMITS.fileBytes) throw new Error('Eval import requires a regular file up to 64 MiB');
      const bytes = Buffer.alloc(stat.size + 1); let offset = 0;
      while (offset < bytes.length) { const r = await handle.read(bytes, offset, bytes.length - offset); if (!r.bytesRead) break; offset += r.bytesRead; }
      if (offset > stat.size) throw new Error('Import file grew while reading');
      return this.import(bytes.subarray(0, offset));
    } finally { await handle.close(); }
  }
}

const createStableSuffix = (source: string, id: string) => sha256(`${source}:${id}`).slice(0, 12);
