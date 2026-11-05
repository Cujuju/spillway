import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClickHouseCredentials } from '@shared/clickhouse';
import { DEFAULT_CLICKHOUSE_CONFIG } from '@shared/clickhouse';
import { ActivityLog } from './activityStore';
import { parseActivityEvent } from './sse';
import { startDemoClickHouse } from '../../scripts/demo/clickhouse.mts';

const mock = vi.hoisted(() => ({ log: null as ActivityLog | null, credentials: undefined as (ClickHouseCredentials & { endpoint: string }) | undefined, beforeConfigure: undefined as (() => void) | undefined, secretFailure: false }));
vi.mock('./activityService', () => ({ activityLog: { call: async (method: string, ...args: unknown[]) => {
  const log = mock.log as unknown as Record<string, (...params: unknown[]) => unknown>;
  if (method === 'clickhouseConfigure') { const hook = mock.beforeConfigure; mock.beforeConfigure = undefined; hook?.(); }
  return log[method]!.apply(log, args);
} } }));
vi.mock('./settingsStore', () => ({ getSecrets: () => ({ clickhouse: mock.credentials }), setClickHouseCredentials: async (c: ClickHouseCredentials | null, endpoint: string) => {
  if (mock.secretFailure) throw new Error('Synthetic secrets write failure');
  mock.credentials = c ? { ...c, endpoint } : undefined;
} }));

let dir: string;
let service: typeof import('./clickhouseService');
const servers: Awaited<ReturnType<typeof startDemoClickHouse>>[] = [];
beforeEach(async () => {
  vi.resetModules(); dir = mkdtempSync(path.join(os.tmpdir(), 'spillway-ch-service-'));
  mock.log = new ActivityLog({ activityDb: path.join(dir, 'activity.db'), legacyActivityDir: path.join(dir, 'legacy'), databaseKey: 'ab'.repeat(32), retentionDays: 7 });
  mock.credentials = { username: 'old-user', password: 'old-password', endpoint: '' }; mock.beforeConfigure = undefined; mock.secretFailure = false;
  service = await import('./clickhouseService');
});
afterEach(async () => { await service.cancelClickHouse(true); mock.log?.close(); for (const s of servers.splice(0)) await s.close(); rmSync(dir, { recursive: true, force: true }); });
async function setup() {
  const s = await startDemoClickHouse(); servers.push(s);
  const config = { ...DEFAULT_CLICKHOUSE_CONFIG, enabled: true, endpoint: s.endpoint };
  mock.credentials = { ...mock.credentials!, endpoint: s.endpoint };
  mock.log!.clickhouseConfigure(config); mock.log!.archiveObserve(parseActivityEvent('{"request_id":"execution-one","trace_id":"full-trace-0001","model":"alias","provider":"codex"}')!);
  return { s, config };
}
it('cancels old in-flight credentials before replacement and never returns them in status', async () => {
  const { s, config } = await setup(); s.behavior.insertDelayMs = 100;
  const received = once(s.events, 'insert'), running = service.clickhouseUploader.runOnce(); await received;
  await service.saveClickHouse(config, { username: 'new-user', password: 'new-password' }); await service.cancelClickHouse(); await running;
  expect(mock.log!.clickhouseStatus()).toMatchObject({ queued: 1, acknowledged: 0 });
  expect(JSON.stringify(await service.clickhouseStatus())).not.toMatch(/old-password|new-password|new-user/);
  s.behavior.insertDelayMs = 0; await service.clickhouseUploader.runOnce();
  expect(s.requests.filter((r) => r.sql.startsWith('INSERT')).at(-1)?.key).toBe('new-password'); expect(mock.log!.clickhouseStatus().queued).toBe(0);
});
it('clears old-target in-flight work before requeueing retained data at a new target', async () => {
  const { s, config } = await setup(); s.behavior.insertDelayMs = 100;
  const received = once(s.events, 'insert'), running = service.clickhouseUploader.runOnce(); await received;
  const old = mock.log!.clickhousePrepare()!;
  await service.clearClickHouse(); await service.cancelClickHouse(); await running;
  const target = await startDemoClickHouse(); servers.push(target);
  await service.saveClickHouse({ ...config, endpoint: target.endpoint }); await service.cancelClickHouse();
  expect(mock.credentials).toBeUndefined();
  const next = mock.log!.clickhousePrepare()!; expect(next.destination).not.toBe(old.destination);
  mock.log!.clickhouseAcknowledge(old.token, old.destination); expect(mock.log!.clickhouseStatus().queued).toBe(1);
  await service.clickhouseUploader.runOnce(); expect(target.rows.size).toBe(1); expect(mock.log!.clickhouseStatus().queued).toBe(0);
});
it('does not restart an older paused operation after a later Cancel', async () => {
  let finish!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const operation = service.withClickHousePaused(() => new Promise<void>((resolve) => { finish = resolve; entered(); }));
  await started; const cancelled = service.cancelClickHouse(); finish(); await operation; await cancelled;
  expect(service.clickhouseUploader.paused).toBe(true);
});
it('keeps old credentials when live traffic makes a destination change fail its atomic backlog check', async () => {
  const { config } = await setup(); mock.log!.clickhouseClear();
  mock.beforeConfigure = () => mock.log!.archiveObserve(parseActivityEvent('{"request_id":"racing-event","trace_id":"full-trace-race"}')!);
  await expect(service.saveClickHouse({ ...config, endpoint: 'http://127.0.0.1:1' }, { username: 'new', password: 'new-secret' })).rejects.toThrow(/Clear/);
  await service.cancelClickHouse();
  expect(mock.credentials).toMatchObject({ password: 'old-password', endpoint: config.endpoint });
  expect(mock.log!.clickhouseStatus().config).toEqual(config);
});
it('leaves a staged destination disabled after secrets failure, with no old credential binding', async () => {
  const { config } = await setup(); mock.log!.clickhouseClear(); mock.secretFailure = true;
  await expect(service.saveClickHouse({ ...config, endpoint: 'http://127.0.0.1:1' }, { username: 'new', password: 'new' })).rejects.toThrow(/Synthetic/);
  await service.cancelClickHouse();
  expect(await service.clickhouseStatus()).toMatchObject({ config: { endpoint: 'http://127.0.0.1:1', enabled: false }, hasCredentials: false });
  expect(mock.credentials?.endpoint).toBe(config.endpoint);
});
it('holds an explicit cancellation through Check and Clear, until Retry resumes it', async () => {
  await setup(); await service.cancelClickHouse();
  await service.clearClickHouse(); expect(service.clickhouseUploader.paused).toBe(true);
  await service.diagnoseClickHouse(false); expect(service.clickhouseUploader.paused).toBe(true);
  await service.retryClickHouse(); expect(service.clickhouseUploader.paused).toBe(false);
});
