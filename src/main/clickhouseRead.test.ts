import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { localDay } from '@shared/activityCounts';
import { OLDER_DAYS_WINDOW } from '@shared/activityOlder';
import { EVERY_REQUEST, inScope, type ActivityScope } from '@shared/activityScope';
import { DEFAULT_CLICKHOUSE_CONFIG } from '@shared/clickhouse';
import { ACTIVITY_PAGE_SIZE, type ActivityEvent } from '@shared/types';
import { startDemoClickHouse, type DemoClickHouseRow } from '../../scripts/demo/clickhouse.mts';
import { ActivityLog, oldestKeptDay } from './activityStore';
import { parseActivityEvent } from './sse';

const mock = vi.hoisted(() => ({ log: null as ActivityLog | null }));
vi.mock('./activityService', () => ({ activityLog: { call: async (method: 'clickhouseStatus' | 'activityOlderBoundaries') => mock.log![method]() } }));
vi.mock('./settingsStore', () => ({ getSecrets: () => ({}) }));

const RETENTION_DAYS = 7;
let dir: string;
let fake: Awaited<ReturnType<typeof startDemoClickHouse>>;
let service: typeof import('./clickhouseService');
const reader = () => service.clickhouseActivityReader;
beforeEach(async () => {
  vi.resetModules();
  dir = mkdtempSync(path.join(os.tmpdir(), 'spillway-ch-read-'));
  mock.log = new ActivityLog({ activityDb: path.join(dir, 'activity.db'), legacyActivityDir: path.join(dir, 'legacy'), databaseKey: randomBytes(32).toString('hex'), retentionDays: RETENTION_DAYS });
  fake = await startDemoClickHouse();
  service = await import('./clickhouseService');
});
afterEach(async () => {
  await service.cancelClickHouse(true);
  await fake.close();
  mock.log?.close();
  rmSync(dir, { recursive: true, force: true });
});

const cutoff = () => oldestKeptDay(Date.now(), RETENTION_DAYS);
function start(daysBeforeCutoff = 0): number {
  const date = new Date(`${cutoff()}T00:00:00`);
  date.setDate(date.getDate() - daysBeforeCutoff);
  return date.getTime();
}
const instant = (at: number) => new Date(at).toISOString();
function enable() {
  mock.log!.clickhouseConfigure({ ...DEFAULT_CLICKHOUSE_CONFIG, enabled: true, endpoint: fake.endpoint });
}
function event(at: number, requestId: string, overrides?: Partial<ActivityEvent>): ActivityEvent {
  return { ...parseActivityEvent(JSON.stringify({ at: instant(at), request_id: requestId, provider: 'codex', model: 'gpt-6.1-sol' }))!, ...overrides };
}
function fact(kind: string, at: number, seq: number, record: unknown, key = String(seq), source_id = 'first-source'): DemoClickHouseRow {
  return { kind, at: instant(at), seq, source_id, record_key: key, record_json: JSON.stringify(record) };
}
function total(at: number, seq: number, requests: number, key = String(seq)): DemoClickHouseRow {
  return fact('total', at, seq, { key, total: { day: localDay(at), start: at, provider: 'codex', model: 'gpt-6.1-sol', authIndex: null, requests } }, key);
}
const pageOf = (day: string) => ({ day, scope: EVERY_REQUEST, failedOnly: false, offset: 0, whole: false });

it('leaves the destination untouched when export is off or a query is malformed', async () => {
  mock.log!.clickhouseConfigure({ ...DEFAULT_CLICKHOUSE_CONFIG, endpoint: fake.endpoint });
  expect(await reader().buckets({ from: 0, to: start() })).toEqual({ state: 'off' });
  expect(await reader().days({ before: null, scope: EVERY_REQUEST })).toEqual({ state: 'off' });
  expect(await reader().page(pageOf(localDay(start(1))))).toEqual({ state: 'off' });
  enable();
  expect(await reader().buckets({ from: -1, to: Infinity })).toEqual({ state: 'ok', buckets: [], truncated: false });
  expect(await reader().days({ before: '2026-02-30' })).toEqual({ state: 'ok', days: [], from: '', earlier: false });
  expect(await reader().page({ ...pageOf(localDay(start(1))), offset: 0.5 })).toEqual({ state: 'ok', events: [], more: false, truncated: false });
  expect(fake.requests).toEqual([]);
});

it('returns status-only unavailability for HTTP, disconnect and malformed response failures', async () => {
  enable();
  const query = () => reader().buckets({ from: 0, to: start() });
  fake.behavior.status = 500;
  fake.behavior.body = 'synthetic server response';
  expect(await query()).toEqual({ state: 'unavailable', error: 'ClickHouse HTTP 500 (server or schema failure)' });
  fake.behavior.status = 200;
  expect(await query()).toEqual({ state: 'unavailable', error: 'ClickHouse read returned an unexpected response' });
  fake.behavior.disconnect = true;
  expect(await query()).toEqual({ state: 'unavailable', error: 'ClickHouse connection failed or timed out; check endpoint, TLS and network' });
});

it('uses inclusive span endpoints and excludes the first local total day', async () => {
  enable();
  const from = start(2), boundary = start(1);
  const next = total(from, 2, 9, 'updated-total');
  fake.addRows([total(from - 1, 1, 11), total(from, 1, 2, 'updated-total'), next, next, total(boundary, 3, 13)]);
  expect(await reader().buckets({ from, to: from })).toMatchObject({ state: 'ok', truncated: false,
    buckets: [{ start: from, requests: 9, client: null, source: 'proxy', detailRequests: 0, wholeDay: false }] });
  mock.log!.append(event(boundary + 1, 'local-total'));
  expect(await reader().buckets({ from, to: boundary })).toMatchObject({ state: 'ok', buckets: [{ start: from, requests: 9 }] });
  const count = fake.requests.length;
  expect(await reader().buckets({ from: boundary, to: boundary })).toEqual({ state: 'ok', buckets: [], truncated: false });
  expect(fake.requests).toHaveLength(count);
});

it('groups local days after dedupe and applies the same scope as request pages', async () => {
  enable();
  const at = start(1), day = localDay(at);
  const scope: ActivityScope = { source: 'proxy', accounts: ['', "scope-value'"], clients: ['example-app'], efforts: ['high'] };
  const match = event(at, 'match', { authIndex: "scope-value'", client: 'example-app', reasoningEffort: 'high', failed: true });
  const events = [match, { ...match, requestId: 'missing-account', authIndex: null, failed: false },
    { ...match, requestId: 'client-log', source: 'client-log' as const }, { ...match, requestId: 'other-client', client: 'other-app' },
    { ...match, requestId: 'other-effort', reasoningEffort: 'low' }, { ...match, requestId: 'other-account', authIndex: 'another' }];
  const latest = fact('request', at, 2, match, 'updated');
  const earlier = start(OLDER_DAYS_WINDOW + 1);
  fake.addRows([
    fact('request', at, 1, { ...match, failed: false, requestId: 'superseded' }, 'updated'),
    latest, latest, ...events.slice(1).map((row, i) => fact('request', at, i + 3, row, i === 0 ? 'updated' : row.requestId, 'second-source')),
    fact('request', start(), 101, event(start(), 'at-cutoff')),
    fact('request', start() + 1, 102, event(start() + 1, 'after-cutoff')),
    fact('request', earlier, 103, event(earlier, 'before-window')),
  ]);
  const scoped = events.filter((row) => inScope(scope, row));
  expect(await reader().days({ before: localDay(start(-1)), scope })).toEqual({
    state: 'ok', from: localDay(start(OLDER_DAYS_WINDOW)), earlier: true, days: [
      { day, requests: scoped.length, failed: scoped.filter((row) => row.failed).length, newestId: 0, costUsd: 0, unpricedRequests: 0 },
    ],
  });
  expect(await reader().page({ ...pageOf(day), scope, failedOnly: true })).toMatchObject({
    state: 'ok', events: scoped.filter((row) => row.failed).map(({ requestId }) => ({ requestId })), more: false, truncated: false,
  });
  expect(await reader().days({ before: localDay(start(OLDER_DAYS_WINDOW)), scope: EVERY_REQUEST })).toMatchObject({
    state: 'ok', earlier: false, days: [{ day: localDay(earlier), requests: 1 }],
  });
  const count = fake.requests.length;
  expect(await reader().page(pageOf(cutoff()))).toEqual({ state: 'ok', events: [], more: false, truncated: false });
  expect(fake.requests).toHaveLength(count);
  for (const { sql, url } of fake.requests) {
    expect(sql).toMatch(/^SELECT /);
    expect(sql).not.toMatch(/scope-value|example-app|\b(SETTINGS|FINAL)\b|SELECT \*/);
    const params = new URL(url, fake.endpoint).searchParams;
    expect(params.get('param_kind')).toBe('request');
    expect(params.has('param_from') && params.has('param_to') && params.has('param_limit')).toBe(true);
    expect([...params.keys()].every((key) => key.startsWith('param_'))).toBe(true);
  }
});

it('pages newest first with stable negative ordinals and caps whole-day reads', async () => {
  enable();
  const at = start(1), onePagePlusOne = ACTIVITY_PAGE_SIZE + 1;
  const generated = Array.from({ length: onePagePlusOne }, (_, i) => fact('request', at, i + 1, event(at, `request-${i + 1}`)));
  fake.addRows(generated);
  const query = pageOf(localDay(at));
  const first = await reader().page(query), next = await reader().page({ ...query, offset: ACTIVITY_PAGE_SIZE });
  expect(first).toMatchObject({ state: 'ok', more: true, truncated: false });
  expect(next).toMatchObject({ state: 'ok', more: false, truncated: false, events: [{ id: -onePagePlusOne, requestId: 'request-1' }] });
  if (first.state !== 'ok' || next.state !== 'ok') throw new Error('Expected request pages');
  expect(first.events).toHaveLength(ACTIVITY_PAGE_SIZE);
  expect(first.events[0]).toMatchObject({ id: -1, requestId: `request-${onePagePlusOne}` });
  const all = [...first.events, ...next.events];
  expect(new Set(all.map((row) => row.id)).size).toBe(onePagePlusOne);
  expect(await reader().page({ ...query, offset: 1, whole: true })).toEqual({ state: 'ok', more: false, truncated: false, events: all });
  const limit = Number(new URL(fake.requests.at(-1)!.url, fake.endpoint).searchParams.get('param_limit'));
  fake.addRows(Array.from({ length: limit - generated.length }, (_, i) => {
    const seq = generated.length + i + 1;
    return fact('request', at + 1, seq, event(at + 1, `extra-${seq}`));
  }));
  const capped = await reader().page({ ...query, whole: true });
  expect(capped).toMatchObject({ state: 'ok', more: false, truncated: true });
  if (capped.state !== 'ok') throw new Error('Expected capped request page');
  expect(capped.events).toHaveLength(limit - 1);
});

it('keeps reused keys apart, reads exported timestamps as UTC and skips a day still stored locally', async () => {
  enable();
  const at = start(2), day = localDay(at);
  // The exporter writes DateTime64 text without a zone suffix.
  const wire = (ms: number) => instant(ms).replace('T', ' ').slice(0, -1);
  fake.addRows([
    { ...fact('request', at, 1, event(at, 'before-clear'), 'reused'), at: wire(at) },
    { ...fact('request', at + 1, 2, event(at + 1, 'after-clear'), 'reused'), at: wire(at + 1) },
  ]);
  expect(await reader().page(pageOf(day))).toMatchObject({ state: 'ok', events: [{ requestId: 'after-clear' }, { requestId: 'before-clear' }] });
  // The first append prunes; the second leaves a day past retention stored until the next prune.
  mock.log!.append(event(Date.now(), 'today'));
  mock.log!.append(event(at + 2, 'not-yet-pruned'));
  const count = fake.requests.length;
  expect(await reader().page(pageOf(day))).toEqual({ state: 'ok', events: [], more: false, truncated: false });
  expect(fake.requests).toHaveLength(count);
});
