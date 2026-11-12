import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { tokenCost } from '@shared/modelPrices';
import type { ActivityEvent } from '@shared/types';
import { ActivityLog } from './activityStore';
import { openActivityDb } from './activityDb';
import { rebuildRetainedTotals } from './activityMigration';
import { totalKey, type ActivityTotal } from './activityTotals';

vi.mock('electron', () => ({ app: { requestSingleInstanceLock: vi.fn(), exit: vi.fn(), whenReady: vi.fn(), commandLine: { hasSwitch: vi.fn(), getSwitchValue: vi.fn() } } }));
vi.mock('./paths', () => ({ appPaths: {} }));
vi.mock('./settingsStore', () => ({ getSettings: () => ({}), getSecrets: () => ({}), loadSecrets: vi.fn(), writeFileAtomic: vi.fn() }));
const { exportData, importData, transferKey, runTransferMode, TRANSFER_EXIT } = await import('./dataTransfer');
const key = transferKey('ab'.repeat(32));
const dirs: string[] = [];
const logs: ActivityLog[] = [];
const empty = { samples: [], summaries: [], observed: [] };
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'spillway-transfer-'));
  dirs.push(dir);
  const config = { activityDb: path.join(dir, 'activity.db'), legacyActivityDir: path.join(dir, 'legacy'), databaseKey: 'cd'.repeat(32), retentionDays: 30 };
  const log = new ActivityLog(config);
  logs.push(log);
  return { log, config, file: path.join(dir, 'transfer.enc') };
}
const event = (patch: Partial<ActivityEvent> = {}): ActivityEvent => ({
  at: new Date().toISOString(), requestId: 'request', selectionId: null, upstreamId: null, source: 'proxy', provider: 'claude', model: 'claude-opus-5-5', authIndex: 'a',
  stream: true, failed: false, statusCode: null, error: null, latencyMs: 100, ttftMs: 10, inputTokens: 10, outputTokens: 5, cachedTokens: 1, cacheWriteTokens: 2,
  sessionId: null, movedFrom: null, userAgent: null, client: null, ...patch,
});
afterEach(() => {
  for (const log of logs.splice(0)) log.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
it('round trips encrypted activity and history, and replays idempotently without checkpoints', async () => {
  const a = fixture(); const b = fixture();
  a.log.append(event());
  const records = { ...empty, samples: [{ at: new Date().toISOString(), used: { a: { weekly: 10 } } }] };
  expect(await exportData(a.file, key, a.log, records)).toBe(1);
  const before = vi.fn();
  importData(a.file, key, b.log, before);
  expect(before).toHaveBeenCalledWith(records);
  expect(b.log.totalsList()).toEqual(a.log.totalsList());
  const totals = b.log.totalsList();
  importData(a.file, key, b.log, before);
  expect(b.log.totalsList()).toEqual(totals);
  b.log.close();
  const db = openActivityDb(b.config.activityDb, b.config.databaseKey);
  try { expect(db.prepare('SELECT * FROM client_log_checkpoints').all()).toEqual([]); }
  finally { db.close(); }
});
it('transfers a pruned identity with its historically accounted cost', async () => {
  const a = fixture(); const b = fixture();
  a.log.append(event({ at: '2020-01-01T12:00:00Z' }));
  a.log.prune(); a.log.close();
  const db = openActivityDb(a.config.activityDb, a.config.databaseKey);
  try {
    db.exec("UPDATE usage_identities SET event = json_set(event, '$.costUsd', 7, '$.uncachedCostUsd', 9)");
  } finally { db.close(); }
  await exportData(a.file, key, a.log, empty);
  importData(a.file, key, b.log, () => undefined);
  expect(b.log.totalsList()[0]).toMatchObject({ requests: 1, costUsd: 7, uncachedCostUsd: 9 });
  const totals = b.log.totalsList();
  importData(a.file, key, b.log, () => undefined);
  expect(b.log.totalsList()).toEqual(totals);
  expect(b.log.days()).toEqual([]);
});
it.each([false, true])('preserves retained historical costs across transfers, migrated: %s', async (migrated) => {
  const a = fixture(); const b = fixture(); const c = fixture();
  a.log.append(event());
  a.log.close();
  const db = openActivityDb(a.config.activityDb, a.config.databaseKey);
  try {
    const row = db.prepare('SELECT key, total FROM activity_totals').get() as { key: string; total: string };
    const total = JSON.parse(row.total) as ActivityTotal;
    total.costUsd *= 2;
    total.uncachedCostUsd *= 2;
    // Detail costs are parts of costUsd, so a historical price scales them too.
    total.detailCostUsd *= 2;
    if (migrated) {
      delete total.start;
      db.prepare('DELETE FROM activity_totals WHERE key = ?').run(row.key);
      db.prepare('INSERT INTO activity_totals VALUES (?, ?)').run(totalKey(total), JSON.stringify(total));
      rebuildRetainedTotals(db);
    } else {
      db.prepare('UPDATE activity_totals SET total = ? WHERE key = ?').run(JSON.stringify(total), row.key);
      db.exec("UPDATE usage_identities SET event = json_set(event, '$.costUsd', json_extract(event, '$.costUsd') * 2, '$.uncachedCostUsd', json_extract(event, '$.uncachedCostUsd') * 2)");
    }
  } finally { db.close(); }
  const expected = a.log.totalsList();
  await exportData(a.file, key, a.log, empty);
  importData(a.file, key, b.log, () => undefined);
  expect(b.log.totalsList()).toEqual(expected);
  importData(a.file, key, b.log, () => undefined);
  expect(b.log.totalsList()).toEqual(expected);
  await exportData(b.file, key, b.log, empty);
  importData(b.file, key, c.log, () => undefined);
  expect(c.log.totalsList()).toEqual(expected);
  b.log.close();
  const imported = openActivityDb(b.config.activityDb, b.config.databaseKey);
  try {
    const row = imported.prepare('SELECT event FROM requests').get() as { event: string };
    expect(JSON.parse(row.event)).not.toHaveProperty('costUsd');
    expect(JSON.parse(row.event)).not.toHaveProperty('uncachedCostUsd');
  } finally { imported.close(); }
});

it('does not attach a pruned identity cost to a reused request row id', () => {
  const a = fixture();
  a.log.append(event({ requestId: 'pruned', at: '2020-01-01T12:00:00Z' }));
  a.log.append(event({ requestId: 'retained' }));
  a.log.close();
  const db = openActivityDb(a.config.activityDb, a.config.databaseKey);
  try {
    db.exec("UPDATE usage_identities SET event = json_set(event, '$.costUsd', 7, '$.uncachedCostUsd', 9) WHERE json_extract(event, '$.requestId') = 'pruned'");
  } finally { db.close(); }
  const exported = [...a.log.exportEvents()] as (ActivityEvent & { costUsd: number })[];
  expect(exported).toHaveLength(2);
  expect(exported.find((e) => e.requestId === 'pruned')?.costUsd).toBe(7);
  expect(exported.find((e) => e.requestId === 'retained')?.costUsd).not.toBe(7);
});
it.each([false, true])('reconciles client and proxy usage across apps, client first: %s', async (clientFirst) => {
  const a = fixture(); const b = fixture();
  const proxy = event({ upstreamId: 'msg_merge', sessionId: 'claude:s' });
  const client = { ...proxy, requestId: 'client', source: 'client-log' as const, authIndex: null };
  a.log.append(clientFirst ? client : proxy);
  b.log.append(clientFirst ? proxy : client);
  await exportData(a.file, key, a.log, empty);
  importData(a.file, key, b.log, () => undefined);
  importData(a.file, key, b.log, () => undefined);
  expect(b.log.totalsList().reduce((n, t) => n + t.requests, 0)).toBe(1);
});
it('rejects tampering before the backup or write callback or opening the target', async () => {
  const a = fixture(); const b = fixture();
  a.log.append(event());
  await exportData(a.file, key, a.log, empty);
  const bytes = readFileSync(a.file);
  const ciphertextOffset = 12;
  bytes[ciphertextOffset] = bytes[ciphertextOffset]! ^ 1;
  writeFileSync(a.file, bytes);
  const before = vi.fn();
  expect(() => importData(a.file, key, b.log, before)).toThrow();
  expect(before).not.toHaveBeenCalled();
  expect(b.log.totalsList()).toEqual([]);
});
it.each([undefined, '', 'ab', 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)])('rejects invalid transfer key %s', (value) => {
  expect(() => transferKey(value)).toThrow('64 hex');
});

it('refuses a running app before readiness or transfer work', async () => {
  const { app } = await import('electron');
  vi.mocked(app.requestSingleInstanceLock).mockReturnValue(false);
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    await runTransferMode();
    expect(app.exit).toHaveBeenCalledWith(TRANSFER_EXIT.appRunning);
    expect(app.whenReady).not.toHaveBeenCalled();
  } finally { stderr.mockRestore(); }
});
it('rejects missing transfer file arguments with a named exit code', async () => {
  const { app } = await import('electron');
  vi.mocked(app.requestSingleInstanceLock).mockReturnValue(true);
  vi.mocked(app.commandLine.hasSwitch).mockImplementation((name) => name === 'data-import');
  vi.mocked(app.commandLine.getSwitchValue).mockReturnValue('');
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    await runTransferMode();
    expect(app.exit).toHaveBeenCalledWith(TRANSFER_EXIT.invalidArguments);
    expect(app.whenReady).not.toHaveBeenCalled();
  } finally { stderr.mockRestore(); }
});
it('replays more than one transaction batch and remains idempotent', async () => {
  const a = fixture(); const b = fixture();
  const batch = Array.from({ length: 1001 }, (_, i) => event({ requestId: `batch-${i}` }));
  a.log.importEvents(batch);
  await exportData(a.file, key, a.log, empty);
  const replay = vi.spyOn(b.log, 'importEvents');
  importData(a.file, key, b.log, () => undefined);
  expect(replay.mock.calls.map(([events]) => events.length)).toEqual([1000, 1]);
  const totals = b.log.totalsList();
  importData(a.file, key, b.log, () => undefined);
  expect(b.log.totalsList()).toEqual(totals);
  expect(totals.reduce((n, t) => n + t.requests, 0)).toBe(batch.length);
});

it.each(['claude', 'codex'])('preserves %s billing context through encrypted transfer after retention', async (provider) => {
  const a = fixture(); const b = fixture();
  const original = event({ at: '2020-01-01T12:00:00Z', provider,
    model: provider === 'claude' ? 'claude-opus-5-5' : 'gpt-6.1-sol',
    inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 1_000_000,
    cacheWrite1hTokens: 500_000, cacheWriteLongTokens: 500_000, tier: 'fast' });
  a.log.append(original);
  a.log.prune();
  expect(a.log.days()).toEqual([]);
  const expectedPrice = tokenCost(provider, original.model, original.at, original);
  expect(expectedPrice?.usd).toBeCloseTo(provider === 'claude' ? 13 : 7.5);
  expect([...a.log.exportEvents()][0]).toMatchObject({ cacheWrite1hTokens: 500_000, cacheWriteLongTokens: 500_000, tier: 'fast' });
  await exportData(a.file, key, a.log, empty);
  importData(a.file, key, b.log, () => undefined);
  b.log.close();
  expect(b.log.days()).toEqual([]);
  const restored = [...b.log.exportEvents()][0]!;
  expect(restored).toMatchObject({ cacheWrite1hTokens: 500_000, cacheWriteLongTokens: 500_000, tier: 'fast' });
  expect(tokenCost(provider, restored.model, restored.at, restored)).toEqual(expectedPrice);
  expect(b.log.totalsList()).toEqual(a.log.totalsList());
});
