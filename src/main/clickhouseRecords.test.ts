import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CLICKHOUSE_TABLES_OUTDATED, DEFAULT_CLICKHOUSE_CONFIG, validateClickHouseConfig } from '@shared/clickhouse';
import { startDemoClickHouse } from '../../scripts/demo/clickhouse.mts';
import { openActivityDb, type Db } from './activityDb';
import { ArchiveStore } from './archiveStore';
import { ClickHouseStore } from './clickhouseStore';
import { checkClickHouseSchema } from './clickhouseHttp';
import { RECORD_SPECS, recordLookup } from './clickhouseRecords';

const dirs: string[] = [], dbs: Db[] = [];
afterEach(() => { for (const db of dbs.splice(0)) if (db.open) db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'spillway-records-')); dirs.push(dir);
  const file = path.join(dir, 'activity.db'), db = openActivityDb(file, 'ab'.repeat(32)); dbs.push(db);
  let store: ClickHouseStore;
  const archive = new ArchiveStore(db, { append: (f) => store.append(f) }); store = new ClickHouseStore(db, archive);
  return { db, store, file };
}
const config = { ...DEFAULT_CLICKHOUSE_CONFIG, enabled: true, endpoint: 'http://127.0.0.1:8123' };
const lines = (facts: string) => facts.trim().split('\n').map((s) => JSON.parse(s) as Record<string, unknown>);
const AT = '2026-11-12T05:00:00.000Z';
const event = (tokens: number) => JSON.stringify({ at: AT, traceId: 'trace-a', model: 'claude-opus-5-5', authIndex: 'acct-1', inputTokens: tokens, outputTokens: 7 });
function addRequest(db: Db, tokens = 10): number { return Number(db.prepare("INSERT INTO requests(day,failed,event) VALUES('2026-11-12',0,?)").run(event(tokens)).lastInsertRowid); }
function seedEveryStore(db: Db) {
  addRequest(db);
  db.prepare("INSERT INTO request_settings VALUES('hash-1','{\"effort\":\"high\"}',?)").run(AT);
  db.prepare('INSERT INTO activity_totals VALUES(?,?)').run('total-1', JSON.stringify({ day: '2026-11-12', start: Date.parse(AT), requests: 1 }));
  db.prepare("INSERT INTO clickhouse_mirror VALUES('conversation-title','claude:s1',?,'{\"title\":\"Fix bug\"}')").run(AT);
  db.prepare("INSERT INTO canary_results VALUES('canary-1','2026-11-12',?)").run(JSON.stringify({ id: 'canary-1', at: AT, outcome: 'pass' }));
  db.prepare("INSERT INTO thinking_tests VALUES('setting-1',?)").run(JSON.stringify({ startedAt: AT }));
  db.prepare("INSERT INTO eval_cases(id,revision,created_at,title,bytes,snapshot) VALUES('case-1',1,?,'Case',10,?)").run(AT, JSON.stringify({ id: 'case-1', annotation: { title: 'Case' }, capture: { request: 'secret body' } }));
  db.prepare("INSERT INTO clickhouse_mirror VALUES('usage-sample',?,?,'{}')").run(AT, AT);
}

it('queues every write to an exported table and sends the current row as a keyed v2 record', () => {
  const { db, store } = setup(); store.configure(config); store.prepare();
  const id = addRequest(db, 10);
  db.prepare('UPDATE requests SET event=? WHERE id=?').run(event(25), id);
  expect(store.status().queued).toBe(1);
  const [line] = lines(store.prepare()!.facts);
  expect(line).toMatchObject({ schema_version: 2, kind: 'request', record_key: String(id), trace_id: 'trace-a', at: '2026-11-12 05:00:00.000', content_policy: 'metadata-only' });
  expect(JSON.parse(line!.record_json as string)).toMatchObject({ inputTokens: 25, authIndex: 'acct-1' });
});

it('backfills rows written before export, for every store, then stops', () => {
  const { db, store } = setup(); seedEveryStore(db);
  store.configure(config); expect(store.status().backfilling).toBe(true);
  const kinds = lines(store.prepare()!.facts).map((l) => l.kind);
  expect(new Set(kinds)).toEqual(new Set(['request', 'request-settings', 'total', 'canary', 'thinking-test', 'eval-case', 'usage-sample', 'conversation-title']));
  expect(store.status().backfilling).toBe(false);
});

it('honours per-store switches and restarts backfill when a store turns on', () => {
  const { db, store } = setup(); seedEveryStore(db);
  const off = { ...config, stores: { ...config.stores, requests: false } };
  store.configure(off);
  let batch = store.prepare()!; expect(lines(batch.facts).map((l) => l.kind)).not.toContain('request'); store.acknowledge(batch.token, batch.destination);
  addRequest(db); expect(store.status().queued).toBe(0);
  store.configure(config); batch = store.prepare()!;
  expect(lines(batch.facts).filter((l) => l.kind === 'request')).toHaveLength(2);
});

it('sends eval cases without captured content unless content export is on', () => {
  const { db, store } = setup(); seedEveryStore(db);
  store.configure(config);
  const meta = lines(store.prepare()!.facts).find((l) => l.kind === 'eval-case')!;
  expect(meta.record_json).not.toContain('secret body'); expect(meta.content_policy).toBe('metadata-only');
  store.clear(); store.configure({ ...config, includeBodies: true });
  const full = lines(store.prepare()!.facts).find((l) => l.kind === 'eval-case')!;
  expect(full.record_json).toContain('secret body'); expect(full.content_policy).toBe('included');
});

it('counts a queued record whose row left local storage as discarded instead of sending it', () => {
  const { db, store } = setup(); store.configure(config); store.prepare();
  const id = addRequest(db); db.prepare('DELETE FROM requests WHERE id=?').run(id);
  expect(store.prepare()).toBeNull(); expect(store.status()).toMatchObject({ queued: 0, discarded: 1 });
});

it('mirrors usage only while exported and skips unchanged rows', () => {
  const { db, store } = setup(); const before = { before: '2026-01-01T00:00:00.000Z' };
  const usage = [{ kind: 'usage-window' as const, key: 'acct|5h|1', at: AT, record: '{"peak":10}' }];
  store.mirror('usage', usage, before); expect(db.prepare('SELECT count(*) AS n FROM clickhouse_mirror').get()).toEqual({ n: 0 });
  store.configure(config); store.prepare();
  store.mirror('usage', usage, before); const batch = store.prepare()!; store.acknowledge(batch.token, batch.destination);
  store.mirror('usage', usage, before); expect(store.status().queued).toBe(0);
  store.mirror('usage', [{ ...usage[0]!, record: '{"peak":40}' }], before);
  expect(JSON.parse(lines(store.prepare()!.facts)[0]!.record_json as string)).toEqual({ peak: 40 });
});

it('re-sends a renamed conversation title and retires titles a complete pass no longer finds', () => {
  const { db, store } = setup(); store.configure(config); store.prepare();
  const title = (key: string, text: string) => ({ kind: 'conversation-title' as const, key, at: AT, record: JSON.stringify({ sessionId: key, title: text }) });
  store.mirror('titles', [title('claude:a', 'Draft'), title('codex:b', 'Other')], { notPushed: true });
  let batch = store.prepare()!; expect(lines(batch.facts)).toHaveLength(2); store.acknowledge(batch.token, batch.destination);
  store.mirror('titles', [title('claude:a', 'Renamed')], null);
  batch = store.prepare()!; expect(lines(batch.facts).map((l) => [l.record_key, JSON.parse(l.record_json as string).title])).toEqual([['claude:a', 'Renamed']]); store.acknowledge(batch.token, batch.destination);
  store.mirror('titles', [title('claude:a', 'Renamed')], { notPushed: true });
  expect(db.prepare("SELECT key FROM clickhouse_mirror WHERE kind='conversation-title'").all()).toEqual([{ key: 'claude:a' }]);
  expect(store.status().queued).toBe(0);
});

it('stamps day totals at local midnight as an instant, like hourly totals', () => {
  const { db, store } = setup(); store.configure(config); store.prepare();
  db.prepare('INSERT INTO activity_totals VALUES(?,?)').run('day-1', JSON.stringify({ day: '2026-11-12', requests: 3 }));
  const expected = new Date(2026, 10, 12).toISOString().replace('T', ' ').slice(0, -1);
  expect(lines(store.prepare()!.facts)[0]!.at).toBe(expected);
});

it('keeps triggers only while exporting, reinstalls them on reopen and covers every spec table', () => {
  const { db, store, file } = setup();
  const count = (d: Db) => (d.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name GLOB 'clickhouse_record_*'").get() as { n: number }).n;
  expect(count(db)).toBe(0); store.configure(config); db.close();
  const reopened = openActivityDb(file, 'ab'.repeat(32)); dbs.push(reopened);
  const triggers = (reopened.prepare("SELECT tbl_name FROM sqlite_master WHERE type='trigger' AND name GLOB 'clickhouse_record_*'").all() as { tbl_name: string }[]).map((t) => t.tbl_name);
  expect(new Set(triggers)).toEqual(new Set(RECORD_SPECS.map((s) => s.table)));
  new ClickHouseStore(reopened, new ArchiveStore(reopened)).configure({ ...config, enabled: false }); expect(count(reopened)).toBe(0);
});

it('defaults every store on for configs saved before per-store switches', () => {
  const { stores: _, ...old } = config;
  expect(Object.values(validateClickHouseConfig(old).stores).every(Boolean)).toBe(true);
});

it('offers an upgrade for schema v1 facts tables', async () => {
  const s = await startDemoClickHouse();
  try {
    s.behavior.schemaVersion = 1;
    await expect(checkClickHouseSchema({ ...config, endpoint: s.endpoint }, undefined, new AbortController().signal)).rejects.toThrow(CLICKHOUSE_TABLES_OUTDATED);
    s.behavior.schemaVersion = 2;
    await expect(checkClickHouseSchema({ ...config, endpoint: s.endpoint }, undefined, new AbortController().signal)).resolves.toBeUndefined();
  } finally { await s.close(); }
});

it('finds every queued record by an index, never a table scan', () => {
  const { db } = setup();
  for (const spec of RECORD_SPECS) {
    const params = spec.lookup?.params('key:1') ?? ['key'];
    const plan = (db.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM ${spec.table} t WHERE ${recordLookup(spec)}`).all(...params) as { detail: string }[]).map((r) => r.detail).join(' ');
    expect(plan, spec.kind).toMatch(/SEARCH t USING (INTEGER PRIMARY KEY|(COVERING )?INDEX)/);
  }
});
