import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_ARCHIVE_POLICY } from '@shared/archive';
import { DIAGNOSTIC_LIMITS, type DiagnosticSelection, type DiagnosticSource } from '@shared/diagnosticBundle';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { DiagnosticExporter, writeDiagnosticFile, type DiagnosticDependencies } from './diagnosticExport';
import type { DiagnosticContext } from './diagnosticCollect';
import { DiagnosticPreparation } from './diagnosticPreparation';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function directory() { const dir = await mkdtemp(path.join(os.tmpdir(), 'spillway-bundle-')); dirs.push(dir); return dir; }
const selection: DiagnosticSelection = { operationId: 'operation-one', traceIds: ['full-trace-one'], includeBodies: false, includeSettings: true, includeLogs: true, includeMessages: false };
const missing: DiagnosticSource = { detail: null, attempts: [], attemptsUnavailable: 0, attemptsOmitted: 0 };
function context(): DiagnosticContext {
  return { app: { version: '1', build: null, modified: false, builtAt: null }, proxy: { state: 'stopped', pid: null, port: 8317, startedAt: null, lastError: null, executablePath: null, endpoint: '', userConfigError: null, build: null }, settings: structuredClone(DEFAULT_SETTINGS),
    archive: { policy: { ...DEFAULT_ARCHIVE_POLICY }, entries: 0, bodies: 0, bytes: 0, epoch: null, sequence: 0, dropped: 0, gaps: 0, restarts: 0, storedBytes: 0, threads: 0, overBudgetThreads: 0, diffFallbacks: 0, rejected: 0 }, logs: [], knownSecrets: [] };
}
function setup(overrides: Partial<DiagnosticDependencies> = {}) {
  let time = Date.parse('2026-11-05T12:00:00Z');
  const dependencies: DiagnosticDependencies = { snapshot: vi.fn(async () => missing), context: vi.fn(async () => context()), pickPath: vi.fn(async () => null as string | null), now: () => time,
    formatter: (selected, ctx, now) => { const preparation = new DiagnosticPreparation(selected, ctx, now); return { add: async (record) => preparation.add(record), finish: async () => preparation.finish(), close: async () => {} }; }, ...overrides };
  return { exporter: new DiagnosticExporter(dependencies), dependencies, advance: (ms: number) => { time += ms; } };
}
function largeSource(trace: string, messageSize: number): DiagnosticSource {
  return { detail: { schemaVersion: 1, captureEpoch: null, captureSequence: null, id: `trace:${trace}`, traceId: trace, at: '2026-11-05T00:00:00.000Z', state: 'complete', reason: '', sessionId: null, model: '', provider: '', client: null, method: 'POST', path: '/v1/responses', status: 200, bytes: 240_000, captureId: null,
    request: JSON.stringify(Array.from({ length: 4 }, () => 'x'.repeat(60_000))), response: '', requestDecoded: true, responseDecoded: true, requestType: 'application/json', responseType: '', requestEncoding: '', responseEncoding: '', format: 'http', frames: [], attempts: [] },
  attempts: Array.from({ length: 200 }, (_, i) => ({ requestId: `request-${i}`, at: '2026-11-05T00:00:00Z', failed: true, error: 'e'.repeat(messageSize) })), attemptsOmitted: 0, attemptsUnavailable: 0 };
}
it('saves exactly the frozen preview bytes despite subsequent source changes and ignores returned-preview mutation', async () => {
  const file = path.join(await directory(), 'bundle.json'); const state = setup({ pickPath: async () => file });
  const preview = await state.exporter.prepare(selection), exact = preview.json;
  preview.json = 'renderer-forged-content'; preview.counts.included = 99;
  state.dependencies.context = async () => { const c = context(); c.app.version = 'changed'; return c; };
  expect(await state.exporter.save(preview.token)).toEqual({ state: 'saved', path: file });
  expect(await readFile(file, 'utf8')).toBe(exact); expect(state.dependencies.snapshot).toHaveBeenCalledOnce();
  await expect(state.exporter.save(preview.token)).rejects.toThrow('expired');
});
it('bounds live tokens, expires them, discards operations and permits no forged token or unbounded selection', async () => {
  const { exporter, advance } = setup(); const tokens: string[] = [];
  for (let i = 0; i < 3; i++) tokens.push((await exporter.prepare({ ...selection, operationId: `operation-${i}` })).token);
  await expect(exporter.save(tokens[0]!)).rejects.toThrow('expired');
  exporter.discard('operation-1'); await expect(exporter.save(tokens[1]!)).rejects.toThrow('expired');
  advance(DIAGNOSTIC_LIMITS.previewMs); exporter.expire(); await expect(exporter.save(tokens[2]!)).rejects.toThrow('expired');
  await expect(exporter.save('../../auth.json')).rejects.toThrow('expired');
  await expect(exporter.prepare({ ...selection, traceIds: Array(21).fill('full-trace-one') })).rejects.toThrow('1–20');
  await expect(exporter.prepare({ ...selection, traceIds: ['../../auth.json'] })).rejects.toThrow('1–20');
});
it('deduplicates selected stable traces and reports retention-race absence', async () => {
  const { exporter, dependencies } = setup();
  const preview = await exporter.prepare({ ...selection, traceIds: ['full-trace-one', 'full-trace-one'] });
  expect(dependencies.snapshot).toHaveBeenCalledTimes(1); expect(preview.counts).toMatchObject({ selected: 1, unavailable: 1, bodiesUnavailable: 1 });
  expect(JSON.parse(preview.json).records[0]).toMatchObject({ reason: 'identity-not-retained-at-collection' });
});
it('cancels collection at worker call boundaries and refuses concurrent preparations', async () => {
  let release!: (value: DiagnosticSource) => void;
  const { exporter } = setup({ snapshot: () => new Promise((resolve) => { release = resolve; }) });
  const preparing = exporter.prepare(selection); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await expect(exporter.prepare({ ...selection, operationId: 'operation-two' })).rejects.toThrow('running');
  exporter.discard(selection.operationId); release(missing);
  await expect(preparing).rejects.toThrow('canceled');
});
it('handles save-dialog cancellation and cancellation while the dialog is open without writing', async () => {
  const write = vi.fn(async () => {}); const { exporter } = setup({ write });
  const preview = await exporter.prepare(selection); expect(await exporter.save(preview.token)).toEqual({ state: 'canceled' }); expect(write).not.toHaveBeenCalled();
  let close!: (file: string) => void; const waiting = setup({ pickPath: () => new Promise((resolve) => { close = resolve; }), write });
  const p = await waiting.exporter.prepare(selection), saving = waiting.exporter.save(p.token);
  waiting.exporter.discard(p.token); close('unused.json'); expect(await saving).toEqual({ state: 'canceled' }); expect(write).not.toHaveBeenCalled();
});
it('expires previews while a save dialog is open', async () => {
  let close!: (file: string) => void; const write = vi.fn(async () => {});
  const { exporter, advance } = setup({ pickPath: () => new Promise((resolve) => { close = resolve; }), write });
  const p = await exporter.prepare(selection), saving = exporter.save(p.token); advance(DIAGNOSTIC_LIMITS.previewMs); close('unused.json');
  await expect(saving).rejects.toThrow('expired'); expect(write).not.toHaveBeenCalled();
});
it('surfaces disk errors without leaking paths or losing the reviewed preview', async () => {
  const write = vi.fn().mockRejectedValueOnce(Object.assign(new Error('C:\\private\\auth.json disk full'), { code: 'ENOSPC' })).mockResolvedValueOnce(undefined);
  const { exporter } = setup({ pickPath: async () => 'unused.json', write }); const p = await exporter.prepare(selection);
  await expect(exporter.save(p.token)).rejects.toThrow('Diagnostic save failed (ENOSPC). Preview retained');
  expect(await exporter.save(p.token)).toMatchObject({ state: 'saved' }); expect(write.mock.calls[0]![1]).toBe(p.json);
});
it('refuses overwrite, invalid destinations and pre-canceled writes; leaves no temporary/partial files', async () => {
  const dir = await directory(), file = path.join(dir, 'bundle.json'); await writeFile(file, 'original');
  await expect(writeDiagnosticFile(file, 'replacement', new AbortController().signal)).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(file, 'utf8')).toBe('original'); expect(await readdir(dir)).toEqual(['bundle.json']);
  await expect(writeDiagnosticFile('relative.json', 'data', new AbortController().signal)).rejects.toThrow('new JSON');
  await expect(writeDiagnosticFile(path.join(dir, 'bundle.html'), 'data', new AbortController().signal)).rejects.toThrow('new JSON');
  const abort = new AbortController(); abort.abort(new Error('user canceled'));
  await expect(writeDiagnosticFile(path.join(dir, 'canceled.json'), 'data', abort.signal)).rejects.toThrow('canceled');
  expect(await readdir(dir)).toEqual(['bundle.json']);
});
it('rejects oversized prepared metadata instead of keeping an unbounded preview', async () => {
  const oversized = { ...context(), app: { ...context().app, version: 'x'.repeat(9 * 1024 * 1024) } };
  const { exporter } = setup({ context: async () => oversized });
  // Version labels are bounded before serialization, even if the source is maliciously large.
  const preview = await exporter.prepare(selection); expect(preview.bytes).toBeLessThan(DIAGNOSTIC_LIMITS.preparedBytes);
  expect(preview.json).toContain('[truncated]');
});
it('enforces the total prepared byte cap by explicitly omitting bodies, and rejects oversized metadata', async () => {
  const selected = { ...selection, includeBodies: true, includeMessages: true, traceIds: Array.from({ length: 20 }, (_, i) => `full-trace-${i}`) };
  const bounded = setup({ snapshot: async (trace) => largeSource(trace, 500) });
  const preview = await bounded.exporter.prepare(selected);
  expect(preview.bytes).toBeLessThanOrEqual(DIAGNOSTIC_LIMITS.preparedBytes); expect(preview.counts.bodiesOmitted).toBeGreaterThan(0); expect(preview.counts.included).toBe(20);
  expect(preview.json).toContain('total-export-byte-limit');
  const rejected = setup({ snapshot: async (trace) => largeSource(trace, 4096) });
  await expect(rejected.exporter.prepare(selected)).rejects.toThrow('Selected metadata exceeds 8 MiB');
});
it('cancels an active write through its abort signal and clears previews at shutdown', async () => {
  let started!: () => void; const writing = new Promise<void>((resolve) => { started = resolve; });
  const state = setup({ pickPath: async () => 'unused.json', write: async (_file, _json, signal) => { started(); await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } });
  const p = await state.exporter.prepare(selection), save = state.exporter.save(p.token); await writing;
  state.exporter.clear(); expect(await save).toEqual({ state: 'canceled' }); await expect(state.exporter.save(p.token)).rejects.toThrow('expired');
});
it('awaits write cancellation cleanup before shutdown completes and refuses new work', async () => {
  let release!: () => void, started!: () => void;
  const writing = new Promise<void>((resolve) => { started = resolve; });
  const cleanup = new Promise<void>((resolve) => { release = resolve; });
  const state = setup({ pickPath: async () => 'unused.json', write: async (_file, _json, signal) => {
    started(); await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })); await cleanup; signal.throwIfAborted();
  } });
  const p = await state.exporter.prepare(selection), saving = state.exporter.save(p.token); await writing;
  let finished = false; const shutdown = state.exporter.shutdown().then(() => { finished = true; });
  await Promise.resolve(); expect(finished).toBe(false); release(); await shutdown;
  expect(await saving).toEqual({ state: 'canceled' }); await expect(state.exporter.prepare(selection)).rejects.toThrow('shutting down');
});
it('reports a committed file as saved even when cancellation arrives after publication', async () => {
  const file = path.join(await directory(), 'committed.json');
  let cancel!: () => void;
  const state = setup({ pickPath: async () => file, write: async (destination, json, signal) => { await writeDiagnosticFile(destination, json, signal); cancel(); } });
  const p = await state.exporter.prepare(selection); cancel = () => state.exporter.discard(p.token);
  expect(await state.exporter.save(p.token)).toEqual({ state: 'saved', path: file }); expect(await readFile(file, 'utf8')).toBe(p.json);
});
