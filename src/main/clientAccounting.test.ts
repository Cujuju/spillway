import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { emptyCounts, addEvent, localDay } from '@shared/activityCounts';
import type { ActivityEvent } from '@shared/types';

const dir = mkdtempSync(path.join(tmpdir(), 'spillway-accounting-'));
vi.mock('./paths', () => ({ appPaths: { activityDb: path.join(dir, 'activity.db'), legacyActivityDir: path.join(dir, 'legacy') } }));
vi.mock('./settingsStore', () => ({ getSecrets: () => ({ databaseKey: 'ab'.repeat(32) }), getSettings: () => ({ activity: { retentionDays: 30 } }) }));
const { activityLog } = await import('./activityLog');
const { parseClientLine } = await import('./clientLogParser');
afterAll(() => { activityLog.close(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => activityLog.clear());
const totals = () => activityLog.totalsList().reduce((n, t) => n + t.requests, 0);
const at = new Date().toISOString();
const sampleUsage = (patch: Partial<ActivityEvent> = {}): ActivityEvent => ({
  at, requestId: 'p', source: 'proxy', upstreamId: null, selectionId: null, provider: 'claude', model: 'claude-opus-5-5',
  authIndex: 'a', stream: true, failed: false, statusCode: null, error: null, latencyMs: 0, ttftMs: null,
  inputTokens: 100, outputTokens: 30, cachedTokens: 20, cacheWriteTokens: 10, sessionId: 'claude:s', movedFrom: null,
  userAgent: null, client: 'claude-cli', ...patch,
});

it('reports committed accounting changes but not duplicate replay or checkpoint-only writes', () => {
  const e = sampleUsage({ source: 'client-log' });
  expect(activityLog.importBatch('feedback', 'first', [e])).toBe(true);
  expect(activityLog.importBatch('feedback', 'duplicate', [e])).toBe(false);
  expect(activityLog.importBatch('feedback', 'complete', [])).toBe(false);
  expect(activityLog.checkpoint('feedback')).toBe('complete');
  activityLog.close();
  expect(activityLog.checkpoint('feedback')).toBe('complete');
});

it('replaces preliminary Claude blocks with final usage across files, retention and restart', () => {
  const block = (output: number) => parseClientLine(JSON.stringify({ type: 'assistant', isSidechain: true,
    sessionId: 's', requestId: 'req', timestamp: at, message: { id: 'msg_stream', model: 'claude-opus-5-5',
      content: 'PRIVATE', usage: { input_tokens: 2, output_tokens: output, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 } } }), 'claude', {})!;
  activityLog.importBatch('parent', '1', [block(8)]);
  activityLog.close();
  activityLog.importBatch('subagent', '1', [block(324)]);
  activityLog.importBatch('fork', '1', [block(8), block(324)]);
  expect(totals()).toBe(1);
  const expected = emptyCounts(); addEvent(expected, block(324));
  expect(activityLog.totalsList().reduce((n, t) => n + t.outputTokens, 0)).toBe(324);
  expect(activityLog.totalsList().reduce((n, t) => n + t.costUsd, 0)).toBeCloseTo(expected.costUsd);
  expect(JSON.stringify(activityLog.day(localDay(Date.now())))).not.toContain('PRIVATE');
});

it('reconciles an existing client row when a late upstream ID joins an already stored proxy', () => {
  const local = sampleUsage({ at, requestId: 'local', source: 'client-log', authIndex: null, upstreamId: null });
  activityLog.append(local);
  const proxy = sampleUsage({ at, requestId: 'proxy', upstreamId: 'msg_late', inputTokens: 999 });
  activityLog.append(proxy);
  expect(totals()).toBe(2);
  activityLog.close();
  activityLog.append({ ...local, upstreamId: 'msg_late' });
  expect(totals()).toBe(1);
  expect(activityLog.day(localDay(Date.now())).map((e) => e.source)).toEqual(['proxy']);
  activityLog.append({ ...local, upstreamId: 'msg_late' });
  expect(totals()).toBe(1);
});

it('rolls back rows, totals and checkpoints together on a failed batch', () => {
  const e = sampleUsage({ at, requestId: 'rollback', source: 'client-log' });
  expect(() => activityLog.importBatch('failed', '1', [e, null as unknown as ActivityEvent])).toThrow();
  expect(activityLog.checkpoint('failed')).toBeUndefined();
  expect(totals()).toBe(0);
  expect(activityLog.day(localDay(Date.now()))).toHaveLength(0);
  activityLog.close();
  activityLog.importBatch('failed', '1', [e]);
  expect(totals()).toBe(1);
});

it('keeps checkpoints and identities when requests expire', () => {
  const old = new Date(); old.setDate(old.getDate() - 40);
  const e = sampleUsage({ at: old.toISOString(), requestId: 'expired', source: 'client-log' });
  activityLog.importBatch('expired', 'complete', [e]);
  activityLog.prune(); activityLog.close();
  expect(activityLog.checkpoint('expired')).toBe('complete');
  activityLog.importBatch('expired', 'complete', [e]);
  expect(totals()).toBe(1);
  expect(activityLog.day(localDay(old.getTime()))).toHaveLength(0);
});

it.skipIf(!process.env.SPILLWAY_REVIEW_LOGS)('imports real logs read-only into a disposable database', async () => {
  const { clientLogRoots, importClientFile } = await import('./clientLogSync');
  let maxBatchMs = 0;
  const coverage: Record<string, { first: string; last: string; records: number }> = {};
  for (const root of clientLogRoots()) {
    const counts = coverage[root.provider] = { first: '', last: '', records: 0 };
    for (const file of await readdir(root.dir, { recursive: true })) {
      if (!/\.jsonl(?:\.zst)?$/.test(file)) continue;
      await importClientFile(path.join(root.dir, file), root.provider, {
        checkpoint: (f) => activityLog.checkpoint(f),
        importBatch: (f, s, events) => {
          const start = performance.now();
          activityLog.importBatch(f, s, events);
          maxBatchMs = Math.max(maxBatchMs, performance.now() - start);
          for (const e of events) {
            counts.records++;
            if (!counts.first || e.at < counts.first) counts.first = e.at;
            if (!counts.last || e.at > counts.last) counts.last = e.at;
          }
        },
      });
    }
  }
  activityLog.prune();
  console.log(JSON.stringify({ coverage, requests: totals(), maxBatchMs }));
  expect(coverage.codex!.first.startsWith('2025-11')).toBe(true);
}, 600_000);
