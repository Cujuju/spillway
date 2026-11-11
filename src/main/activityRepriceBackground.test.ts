import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { priceTableSnapshot } from '@shared/modelPrices';
import { addEvent, emptyCounts, localDay } from '@shared/activityCounts';
import type { ActivityEvent } from '@shared/types';
import { ActivityRepriceJob } from './activityRepriceJob';
import { activityPriceSnapshot, repriceActivity } from './activityReprice';
import { ACTIVITY_BUSY_TIMEOUT_MS, openActivityDb } from './activityDb';
import { ActivityLog } from './activityStore';
import { addToTotals, readTotalRows, storedTotalKey } from './activityTotals';
import { rememberUsage } from './usageLedger';

const dir = mkdtempSync(path.join(tmpdir(), 'spillway-background-'));
const key = 'ab'.repeat(32);
let sequence = 0;
const files: string[] = [];
afterEach(() => { for (const file of files.splice(0)) rmSync(file, { force: true }); vi.restoreAllMocks(); });
const fixture = () => {
  const file = path.join(dir, `${sequence++}.db`);
  files.push(file, file + '-wal', file + '-shm');
  const db = openActivityDb(file, key);
  const event = (day: string, requestId = day): ActivityEvent => ({
    at: `${day}T12:00:00Z`, requestId, source: 'proxy', provider: 'claude', model: 'claude-sonnet-5-5',
    authIndex: null, client: null, inputTokens: 100, outputTokens: 20, cachedTokens: 0, cacheWriteTokens: 0,
    failed: false, sessionId: null, upstreamId: null,
  } as ActivityEvent);
  const save = (e: ActivityEvent) => {
    const total = addToTotals(new Map(), e);
    total.costUsd = 99;
    db.prepare('INSERT INTO activity_totals VALUES (?, ?)').run(storedTotalKey(total), JSON.stringify(total));
    const id = Number(db.prepare('INSERT INTO requests(day, failed, event) VALUES (?, 0, ?)').run(total.day, JSON.stringify(e)).lastInsertRowid);
    rememberUsage(db, { ...e, costUsd: 99 }, id);
    return total;
  };
  return { db, file, event, save };
};

it('startup only reads meta and an equal snapshot never creates a worker', () => {
  const { db } = fixture();
  try {
    db.prepare('INSERT INTO meta VALUES (?, ?)').run('activity-price-table', priceTableSnapshot());
    const prepare = vi.spyOn(db, 'prepare');
    const create = vi.fn();
    new ActivityRepriceJob(create, vi.fn()).start(activityPriceSnapshot(db));
    expect(prepare.mock.calls).toEqual([['SELECT value FROM meta WHERE key = ?']]);
    expect(create).not.toHaveBeenCalled();
  } finally { db.close(); }
});

it('logs worker failures without throwing', async () => {
  const worker = new EventEmitter();
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const changed = vi.fn();
  const job = new ActivityRepriceJob(() => worker as Worker, changed);
  job.start(null);
  worker.emit('error', new Error('failed'));
  worker.emit('exit', 1);
  expect(error).toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
  await job.stop();
});

it('commits newest days first, leaves no snapshot on failure, and reruns idempotently', () => {
  const { db, event, save } = fixture();
  try {
    const older = save(event('2026-10-07'));
    const newer = save(event('2026-10-08'));
    db.exec(`CREATE TRIGGER fail_old BEFORE UPDATE ON activity_totals
      WHEN json_extract(old.total, '$.day') = '${older.day}' BEGIN SELECT RAISE(ABORT, 'failed day'); END`);
    expect(() => repriceActivity(db)).toThrow('failed day');
    expect(activityPriceSnapshot(db)).toBeNull();
    expect(readTotalRows(db).find((r) => r.total.day === newer.day)!.total.costUsd).not.toBe(99);
    expect(readTotalRows(db).find((r) => r.total.day === older.day)!.total.costUsd).toBe(99);
    db.exec('DROP TRIGGER fail_old');
    expect(repriceActivity(db)).toBe(true);
    expect(activityPriceSnapshot(db)).toBe(priceTableSnapshot());
    expect(repriceActivity(db)).toBe(false);
  } finally { db.close(); }
});

it('a second writer attempting an append during repricing retains both costs', async () => {
  const { db, file, event, save } = fixture();
  const e = event('2026-10-08');
  const total = save(e);
  const appended = event('2026-10-08', 'concurrent');
  const counts = emptyCounts(); addEvent(counts, appended);
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const worker = new Worker(`
    const { workerData: d, parentPort } = require('node:worker_threads');
    const Database = require(d.module);
    const db = new Database(d.file);
    db.pragma('busy_timeout = ' + d.timeout);
    db.pragma("cipher='chacha20'"); db.pragma("hexkey='" + d.key + "'");
    parentPort.postMessage('ready');
    const signal = new Int32Array(d.signal);
    Atomics.wait(signal, 0, 0);
    Atomics.store(signal, 0, 2); Atomics.notify(signal, 0);
    db.transaction(() => {
      const row = JSON.parse(db.prepare('SELECT total FROM activity_totals WHERE key = ?').get(d.totalKey).total);
      for (const k of Object.keys(d.counts)) row[k] += d.counts[k];
      db.prepare('UPDATE activity_totals SET total = ? WHERE key = ?').run(JSON.stringify(row), d.totalKey);
      db.prepare('INSERT INTO requests(day, failed, event) VALUES (?, 0, ?)').run(d.day, JSON.stringify(d.event));
    }).immediate();
    db.close();
  `, { eval: true, workerData: { module: createRequire(import.meta.url).resolve('better-sqlite3-multiple-ciphers'),
    file, key, timeout: ACTIVITY_BUSY_TIMEOUT_MS, signal: signal.buffer, totalKey: storedTotalKey(total), counts, day: localDay(Date.parse(e.at)), event: appended } });
  const exited = new Promise<void>((resolve, reject) => { worker.on('error', reject); worker.on('exit', (code) => code ? reject(new Error(`exit ${code}`)) : resolve()); });
  try {
    await new Promise<void>((resolve) => worker.once('message', () => resolve()));
    db.function('append_now', () => {
      Atomics.store(signal, 0, 1); Atomics.notify(signal, 0);
      while (Atomics.load(signal, 0) !== 2) Atomics.wait(signal, 0, 1);
      return 0;
    });
    db.exec('CREATE TEMP TRIGGER concurrent_append BEFORE UPDATE ON main.activity_totals BEGIN SELECT append_now(); END');
    repriceActivity(db);
    db.exec('DROP TRIGGER concurrent_append');
    await exited;
    expect(readTotalRows(db)[0]!.total.costUsd).toBeCloseTo(counts.costUsd * 2);
  } finally { await worker.terminate(); db.close(); }
});

it('invalidates cached whole-row totals before an append after an external commit', () => {
  const { db, file, event, save } = fixture();
  const e = event('2026-10-08'); save(e);
  const log = new ActivityLog({ activityDb: file, databaseKey: key, legacyActivityDir: path.join(dir, 'absent'), retentionDays: 365 });
  try {
    expect(log.totalsList()[0]!.costUsd).toBe(99);
    repriceActivity(db);
    log.append(event('2026-10-08', 'after-reprice'));
    const counts = emptyCounts(); addEvent(counts, e);
    expect(log.totalsList()[0]!.costUsd).toBeCloseTo(counts.costUsd * 2);
  } finally { log.close(); db.close(); }
});

it('an import invalidation during the pass cannot be hidden by its final snapshot', () => {
  const { db, event, save } = fixture();
  try {
    save(event('2026-10-08'));
    db.exec(`CREATE TEMP TRIGGER invalidate_on_reprice AFTER UPDATE ON main.activity_totals BEGIN
      DELETE FROM meta WHERE key = 'activity-price-table';
      INSERT OR REPLACE INTO meta VALUES ('activity-price-invalidation', 'imported-during-pass'); END`);
    repriceActivity(db);
    expect(activityPriceSnapshot(db)).toBeNull();
    db.exec('DROP TRIGGER invalidate_on_reprice');
    repriceActivity(db);
    expect(activityPriceSnapshot(db)).toBe(priceTableSnapshot());
  } finally { db.close(); }
});
