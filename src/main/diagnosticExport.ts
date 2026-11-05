import { randomUUID } from 'node:crypto';
import { open, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { DIAGNOSTIC_LIMITS, type DiagnosticPreview, type DiagnosticSaveResult, type DiagnosticSelection, type DiagnosticSource } from '@shared/diagnosticBundle';
import type { DiagnosticContext } from './diagnosticCollect';
import type { DiagnosticFormatter } from './diagnosticPreparation';

export interface DiagnosticDependencies {
  snapshot(traceId: string, bodies: boolean): Promise<DiagnosticSource>;
  context(): Promise<DiagnosticContext>;
  pickPath(filename: string): Promise<string | null>;
  formatter(selection: DiagnosticSelection, context: DiagnosticContext, now: number, signal: AbortSignal): DiagnosticFormatter;
  now?: () => number;
  write?: typeof writeDiagnosticFile;
}
interface Prepared { preview: DiagnosticPreview; operationId: string }
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(value);
function normalizeSelection(raw: DiagnosticSelection): DiagnosticSelection {
  if (!raw || !validId(raw.operationId) || !Array.isArray(raw.traceIds) || !raw.traceIds.length || raw.traceIds.length > DIAGNOSTIC_LIMITS.records || !raw.traceIds.every(validId)) throw new Error('Select 1–20 full archive trace identities');
  return { operationId: raw.operationId, traceIds: [...new Set(raw.traceIds)], includeBodies: raw.includeBodies === true, includeSettings: raw.includeSettings === true, includeLogs: raw.includeLogs === true, includeMessages: raw.includeMessages === true,
    excludedRecords: Number.isSafeInteger(raw.excludedRecords) ? Math.max(0, Math.min(DIAGNOSTIC_LIMITS.records, raw.excludedRecords!)) : 0 };
}
const canceled = () => new Error('Diagnostic export canceled');
const expired = () => new Error('Preview expired; prepare and inspect a new preview');

/** Exclusive atomic publication never overwrites an existing file or follows a destination symlink. */
export async function writeDiagnosticFile(file: string, json: string, signal: AbortSignal): Promise<void> {
  if (!path.isAbsolute(file) || path.extname(file).toLowerCase() !== '.json' || /[\u0000-\u001f]/.test(file) || (process.platform === 'win32' && file.slice(path.parse(file).root.length).includes(':'))) throw new Error('Choose a new JSON file in the save dialog');
  signal.throwIfAborted();
  const temporary = path.join(path.dirname(file), `.spillway-diagnostic-${randomUUID()}.tmp`);
  let published = false;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(json, { encoding: 'utf8', signal }); await handle.sync(); }
    finally { await handle.close(); }
    signal.throwIfAborted();
    await link(temporary, file);
    published = true;
  } finally {
    try { await unlink(temporary); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !published) throw error; }
  }
}

export class DiagnosticExporter {
  private previews = new Map<string, Prepared>();
  private jobs = new Map<string, AbortController>();
  private writes = new Set<Promise<void>>();
  private shuttingDown = false;
  private now: () => number;
  constructor(private dependencies: DiagnosticDependencies) { this.now = dependencies.now ?? Date.now; }
  expire(): void {
    for (const [token, entry] of this.previews) if (Date.parse(entry.preview.expiresAt) <= this.now()) { this.jobs.get(token)?.abort(expired()); this.previews.delete(token); }
  }
  discard(id: string): void {
    if (!validId(id)) return;
    this.jobs.get(id)?.abort(canceled());
    this.previews.delete(id);
    for (const [token, entry] of this.previews) if (entry.operationId === id) { this.jobs.get(token)?.abort(canceled()); this.previews.delete(token); }
  }
  async prepare(raw: DiagnosticSelection): Promise<DiagnosticPreview> {
    const selection = normalizeSelection(raw);
    this.expire();
    if (this.shuttingDown) throw new Error('Diagnostic export is shutting down');
    if (this.jobs.size) throw new Error('Another diagnostic operation is running');
    const controller = new AbortController();
    this.jobs.set(selection.operationId, controller);
    let formatter: DiagnosticFormatter | undefined;
    try {
      const context = await this.dependencies.context();
      controller.signal.throwIfAborted();
      formatter = this.dependencies.formatter(selection, context, this.now(), controller.signal);
      for (const trace of selection.traceIds) {
        controller.signal.throwIfAborted();
        const source = await this.dependencies.snapshot(trace, selection.includeBodies);
        controller.signal.throwIfAborted();
        await formatter.add(source);
      }
      controller.signal.throwIfAborted();
      const content = await formatter.finish();
      controller.signal.throwIfAborted();
      const now = this.now();
      const token = randomUUID();
      const preview = { token, expiresAt: new Date(now + DIAGNOSTIC_LIMITS.previewMs).toISOString(), filename: `spillway-diagnostic-${new Date(now).toISOString().replace(/[:.]/g, '-')}-${token.slice(0, 8)}.json`, ...content };
      while (this.previews.size >= DIAGNOSTIC_LIMITS.previews) this.discard(this.previews.keys().next().value!);
      this.previews.set(token, { preview, operationId: selection.operationId });
      return structuredClone(preview);
    } finally { try { await formatter?.close(); } finally { this.jobs.delete(selection.operationId); } }
  }
  async save(token: string): Promise<DiagnosticSaveResult> {
    this.expire();
    const entry = this.previews.get(token);
    if (!validId(token) || !entry) throw new Error('Preview expired or was canceled; prepare and inspect a new preview');
    if (this.shuttingDown) throw new Error('Diagnostic export is shutting down');
    if (this.jobs.size) throw new Error('Another diagnostic operation is running');
    const controller = new AbortController();
    this.jobs.set(token, controller);
    try {
      const file = await this.dependencies.pickPath(entry.preview.filename);
      if (!file) return { state: 'canceled' };
      controller.signal.throwIfAborted();
      this.expire();
      if (!this.previews.has(token)) throw new Error('Preview expired; prepare and inspect a new preview');
      const writing = (this.dependencies.write ?? writeDiagnosticFile)(file, entry.preview.json, controller.signal);
      this.writes.add(writing);
      try { await writing; } finally { this.writes.delete(writing); }
      this.previews.delete(token);
      return { state: 'saved', path: file };
    } catch (error) {
      if (controller.signal.aborted) { if ((controller.signal.reason as Error)?.message === expired().message) throw expired(); return { state: 'canceled' }; }
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') throw new Error('File already exists; choose a new filename. Preview retained.');
      if (code) throw new Error(`Diagnostic save failed (${/^[A-Z0-9_]+$/.test(code) ? code : 'I/O'}). Preview retained; choose another location.`);
      throw new Error('Diagnostic save failed or preview expired. Prepare again or choose a new JSON filename.');
    } finally { this.jobs.delete(token); }
  }
  clear(): void { for (const job of this.jobs.values()) job.abort(canceled()); this.previews.clear(); }
  async shutdown(): Promise<void> { this.shuttingDown = true; this.clear(); await Promise.allSettled([...this.writes]); }
}
