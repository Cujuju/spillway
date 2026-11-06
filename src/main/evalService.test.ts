import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evalFixture } from './test/evalFixtures';
import { decodeCaseFile, encodeCaseFile, sha256 } from './evalCaseCodec';

const mocks = vi.hoisted(() => ({ call: vi.fn(), save: vi.fn(), open: vi.fn(), endpoint: 'http://127.0.0.1:8317', key: 'synthetic-current-client-credential', management: 'synthetic-management-credential', database: 'ab'.repeat(32) }));
vi.mock('electron', () => ({ dialog: { showSaveDialog: mocks.save, showOpenDialog: mocks.open } }));
vi.mock('./activityService', () => ({ activityLog: { call: mocks.call } }));
vi.mock('./proxySupervisor', () => ({ proxy: { getStatus: () => ({ state: 'running', endpoint: mocks.endpoint }) } }));
vi.mock('./proxyIdentity', () => ({ proxyIdentity: () => ({ clientApiKeys: [mocks.key], managementKey: mocks.management, managementSecret: mocks.management }) }));
vi.mock('./settingsStore', () => ({ getSecrets: () => ({ clientApiKey: mocks.key, managementKey: mocks.management, databaseKey: mocks.database }) }));
const service = await import('./evalService');
const dirs: string[] = [];
beforeEach(() => { service.invalidateEval(); mocks.call.mockReset(); mocks.save.mockReset(); mocks.open.mockReset(); });
afterEach(() => { service.invalidateEval(); vi.unstubAllGlobals(); vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
it('freezes reviewed bytes, removes exact current secrets, rehashes transformed payload and saves only those bytes', async () => {
  const c = evalFixture(); c.annotation.notes = `Private ${mocks.management}`; c.capture.payload.data!.request = c.capture.payload.data!.request.replace('Say hello', `Value ${mocks.key} ${mocks.database}`); c.capture.payload.sha256 = sha256(JSON.stringify(c.capture.payload.data));
  mocks.call.mockResolvedValue(encodeCaseFile(c));
  const preview = await service.prepareEvalExport(c.id, 1, true);
  for (const secret of [mocks.key, mocks.management, mocks.database]) expect(preview.jsonl).not.toContain(secret);
  const exported = decodeCaseFile(Buffer.from(preview.jsonl)).cases[0]!;
  expect(exported.capture.payload.sha256).not.toBe(c.capture.payload.sha256);
  expect(exported.portability).toMatchObject({ protocol: 'redacted', originalPayloadSha256: c.capture.payload.sha256, replayFidelity: 'not-guaranteed' });
  const dir = mkdtempSync(path.join(os.tmpdir(), 'spillway-eval-export-')); dirs.push(dir); const file = path.join(dir, 'case.jsonl');
  mocks.save.mockResolvedValue({ canceled: false, filePath: file }); await service.saveEvalExport(preview.token);
  expect(readFileSync(file, 'utf8')).toBe(preview.jsonl); await expect(service.saveEvalExport(preview.token)).rejects.toThrow();
});
it('deletion invalidates pending export/replay preparations before RPC completion', async () => {
  const c = evalFixture(); let done!: (value: unknown) => void;
  mocks.call.mockImplementation(() => new Promise((resolve) => { done = resolve; }));
  const exporting = service.prepareEvalExport(c.id, 1, true), rejectedExport = expect(exporting).rejects.toThrow('canceled'); service.invalidateEval(c.id); done(encodeCaseFile(c)); await rejectedExport;
  const preparing = service.prepareEvalReplay(c.id, 1), rejectedReplay = expect(preparing).rejects.toThrow('canceled'); service.invalidateEval(c.id); done(c); await rejectedReplay;
});
it('deletion during native save dialog prevents a completed export from being written', async () => {
  const c = evalFixture(); mocks.call.mockResolvedValue(encodeCaseFile(c)); const p = await service.prepareEvalExport(c.id, 1, false);
  let done!: (value: unknown) => void; mocks.save.mockImplementation(() => new Promise((resolve) => { done = resolve; }));
  const saving = service.saveEvalExport(p.token), rejected = expect(saving).rejects.toThrow('canceled'); service.invalidateEval(c.id);
  done({ canceled: false, filePath: 'must-not-write.jsonl' }); await rejected;
});
it('case deletion/whole clear cancels matching running calls; late resolution cannot restore result state', async () => {
  const c = evalFixture(); let done!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(() => new Promise((resolve) => { done = resolve; })));
  vi.resetModules(); const isolated = await import('./evalService'); mocks.call.mockResolvedValue(c);
  for (const id of [c.id, undefined]) {
    const p = await isolated.prepareEvalReplay(c.id, 1); isolated.evalReplay.start(p.id); isolated.invalidateEval(id);
    done(Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'hello' } }] }));
    await Promise.resolve(); await Promise.resolve(); expect(() => isolated.evalReplay.status(p.id)).toThrow();
  }
});
it('blocks preparations for the entire asynchronous whole-Activity deletion interval', async () => {
  let done!: () => void; const deletion = service.withEvalDeletion(() => new Promise<void>((resolve) => { done = resolve; }));
  await expect(service.prepareEvalReplay(evalFixture().id, 1)).rejects.toThrow('deletion');
  await expect(service.prepareEvalExport(evalFixture().id, 1, false)).rejects.toThrow('deletion');
  expect(mocks.call).not.toHaveBeenCalled(); done(); await deletion;
});
it('binds previews to the immutable requested revision and enforces export TTL', async () => {
  vi.useFakeTimers(); const c = evalFixture(); mocks.call.mockResolvedValue(c);
  const p = await service.prepareEvalReplay(c.id, 1); expect(mocks.call).toHaveBeenCalledWith('evalGet', c.id, 1); expect(p.revision).toBe(1);
  c.annotation.assertions[0]!.value = 'changed in another revision'; expect(p.assertions[0]!.value).toBe('hello');
  mocks.call.mockResolvedValue(encodeCaseFile(evalFixture())); const exported = await service.prepareEvalExport(c.id, 1, false);
  await vi.advanceTimersByTimeAsync(5 * 60_000 + 1); await expect(service.saveEvalExport(exported.token)).rejects.toThrow('fresh'); expect(mocks.save).not.toHaveBeenCalled();
});
