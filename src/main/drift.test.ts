import { importClientFile } from './clientLogSync';
import { openActivityDb } from './activityDb';
import Database from 'better-sqlite3-multiple-ciphers';
import { expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { queryDrift, queryCanaryResults, storeCanaryResults } from './driftStore';
import type { CanaryResult } from '@shared/canary';
import { parseClientLine, type LogContext } from './clientLogParser';
import { parseActivityEvent } from './sse';
import { ActivityLog } from './activityStore';
import { localDay } from '@shared/activityCounts';
import { EVERY_REQUEST } from '@shared/activityScope';
import { requestSettingsHash } from './requestSettings';
import { parseRequestSettings } from '@shared/requestSettings';
it('parses proxy metadata including zero and drops canary traffic', () => {
  const e = parseActivityEvent(JSON.stringify({ request_id: 'a', reasoning_tokens: 0, user_agent: 'claude-cli/2.1.317 extra', request_settings: { max_tokens: 64000 } }))!;
  expect(e).toMatchObject({ thinkingTokens: 0, clientVersion: '2.1.317', settingsHash: requestSettingsHash(parseRequestSettings({ max_tokens: 64000 })!) });
  expect(parseActivityEvent('{"request_id":"a","purpose":"canary"}')).toBeNull();
  expect(parseActivityEvent('{"request_id":"a"}')?.thinkingTokens).toBeNull();
});
it('pairs Claude settings by model without retaining content', () => {
  const c: LogContext = {};
  parseClientLine(JSON.stringify({ type: 'api-request', params: { model: 'opus', thinking: { type: 'enabled', budget_tokens: 1000 }, messages: ['private'] } }), 'claude', c);
  const line = (model: string) => JSON.stringify({ type: 'assistant', timestamp: '2026-11-08', version: '2.1.317', perTurnEffort: 'high', message: { id: 'm', model, usage: { output_tokens_details: { thinking_tokens: 0 } } } });
  const first = parseClientLine(line('opus'), 'claude', c)!;
  expect(first).toMatchObject({ thinkingTokens: 0, clientVersion: '2.1.317', reasoningEffort: 'high', settingsHash: expect.any(String) });
  expect(parseClientLine(line('other'), 'claude', c)?.settingsHash).toBeNull();
  parseClientLine(JSON.stringify({ type: 'api-request', params: { model: 'other', max_tokens: 3000 } }), 'claude', c);
  expect(parseClientLine(line('opus'), 'claude', c)?.settingsHash).toEqual(first.settingsHash);
  expect(JSON.stringify(c)).not.toContain('private');
});
it('reads Codex version, effort, reasoning output', () => {
  const c: LogContext = {};
  for (const r of [{ type: 'session_meta', payload: { id: 's', cli_version: '0.166.0' } }, { type: 'turn_context', payload: { model: 'gpt', effort: 'high' } }]) parseClientLine(JSON.stringify(r), 'codex', c);
  expect(parseClientLine(JSON.stringify({ type: 'token_usage_record', timestamp: '2026-11-08', payload: { response_id: 'r', usage: { output_tokens: 30, reasoning_output_tokens: 20 } } }), 'codex', c)).toMatchObject({ thinkingTokens: 20, clientVersion: '0.166.0', reasoningEffort: 'high', settingsHash: null });
});
it('merges nullable metadata in either arrival order and queries dense scoped days', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'spillway-drift-'));
  const log = new ActivityLog({ activityDb: path.join(dir, 'a.db'), legacyActivityDir: path.join(dir, 'legacy'), databaseKey: 'ab'.repeat(32), retentionDays: 365 });
  const today = localDay(Date.now()), before = new Date(); before.setDate(before.getDate() - 1); const yesterday = localDay(before.getTime());
  try {
    for (const proxyFirst of [true, false]) {
      const id = String(proxyFirst), p = parseActivityEvent(JSON.stringify({ at: new Date().toISOString(), request_id: id, upstream_id: id, provider: 'claude', model: 'opus', output_tokens: 10, user_agent: 'claude-cli/2.1.317' }))!;
      const c = { ...p, requestId: `log-${id}`, source: 'client-log' as const, clientVersion: 'old', thinkingTokens: 5, reasoningEffort: 'high' };
      for (const e of proxyFirst ? [p, c] : [c, p]) log.append(e);
    }
    const report = log.driftQuery({ from: yesterday, to: today, scope: EVERY_REQUEST });
    expect(report.series).toHaveLength(1); expect(report.series[0]?.days).toHaveLength(2);
    expect(report.series[0]?.days[1]).toMatchObject({ replies: 2, thinkingTokens: 10, thinkingKnown: 2 });
    expect(report.series[0]?.changes).toEqual([]);
    expect(log.driftQuery({ from: yesterday, to: today, scope: { ...EVERY_REQUEST, clients: [] } }).series).toEqual([]);
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
});
it('compares prior-range settings, scopes efforts/accounts/source and excludes failed timings', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE requests (id INTEGER PRIMARY KEY, day TEXT, event TEXT); CREATE TABLE request_settings (hash TEXT PRIMARY KEY, settings TEXT, first_at TEXT); CREATE TABLE canary_results (id TEXT PRIMARY KEY, day TEXT, result TEXT)');
  try {
    const a = parseRequestSettings({ max_tokens: 64000 })!, b = parseRequestSettings({ max_tokens: 128000 })!;
    for (const setting of [a, b]) db.prepare('INSERT INTO request_settings VALUES (?, ?, ?)').run(requestSettingsHash(setting), JSON.stringify(setting), '2026-11-01');
    const base = parseActivityEvent(JSON.stringify({ request_id: 'a', provider: 'claude', model: 'alias', reasoning_effort: 'high', user_agent: 'claude-cli/1', auth_index: 'account', latency_ms: 20, ttft_ms: 10, reasoning_tokens: 0, output_tokens: 100 }))!;
    const add = (day: string, fields: object) => db.prepare('INSERT INTO requests(day,event) VALUES (?,?)').run(day, JSON.stringify({ ...base, at: `${day}T12:00:00Z`, ...fields }));
    add('2026-11-01', { settingsHash: requestSettingsHash(a) });
    add('2026-11-02', { settingsHash: requestSettingsHash(b), clientVersion: '2' });
    add('2026-11-02', { failed: true, settingsHash: requestSettingsHash(b), clientVersion: '2' });
    add('2026-11-02', { source: 'client-log', reasoningEffort: 'low' });
    const report = queryDrift(db, { from: '2026-11-02', to: '2026-11-03', scope: { ...EVERY_REQUEST, source: 'proxy', efforts: ['high'], accounts: ['account'] } });
    expect(report.series).toHaveLength(1);
    expect(report.series[0]?.days[0]).toMatchObject({ replies: 1, failed: 1, thinkingKnown: 1, noThinking: 1, ttftCount: 1, ttftSumMs: 10, latencyCount: 1 });
    expect(report.series[0]?.changes).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'settings', from: requestSettingsHash(a), to: requestSettingsHash(b), details: ['max tokens 64,000 → 128,000'] }), expect.objectContaining({ kind: 'client-version', from: '1', to: '2' })]));
    expect(report.series[0]?.days[1]?.replies).toBe(0);
    const result: CanaryResult = { id: 'one', batchId: 'batch', at: new Date().toISOString(), model: 'opus', effort: 'high', effectiveModel: null, probeId: 'test', probeVersion: 1, outcome: 'pass', answer: '1', error: null, outputTokens: 10, thinkingTokens: 0, latencyMs: 1 };
    storeCanaryResults(db, [result, { ...result, id: 'expired', at: '2020-01-01' }]); storeCanaryResults(db, [result]);
    expect(queryCanaryResults(db, { from: '2000-01-01', to: '2099-01-01' })).toEqual([result]);
  } finally { db.close(); }
});

it('bounds change history to the seven-day lookback', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE requests (id INTEGER PRIMARY KEY, day TEXT, event TEXT); CREATE TABLE request_settings (hash TEXT, settings TEXT)');
  try {
    const add = (day: string, version: string) => db.prepare('INSERT INTO requests(day,event) VALUES (?,?)').run(day,
      JSON.stringify({ at: `${day}T12:00:00Z`, provider: 'claude', model: 'opus', clientVersion: version, outputTokens: 1 }));
    add('2026-10-01', 'ancient'); add('2026-11-08', 'current');
    const report = queryDrift(db, { from: '2026-11-08', to: '2026-11-08', scope: EVERY_REQUEST });
    expect(report.series[0]?.changes).toEqual([]);
    expect(report.series[0]?.replies).toBe(1);
  } finally { db.close(); }
});
it('replays imported transcripts after migration without duplicating rows or totals', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'spillway-backfill-'));
  const config = { activityDb: path.join(dir, 'a.db'), legacyActivityDir: path.join(dir, 'legacy'), databaseKey: 'ab'.repeat(32), retentionDays: 365 };
  let log = new ActivityLog(config);
  try {
    const file = path.join(dir, 'transcript.jsonl');
    const settings = parseRequestSettings({ max_tokens: 16000 })!;
    const metadata = { thinkingTokens: 5, clientVersion: '2', reasoningEffort: 'high', settingsHash: requestSettingsHash(settings) };
    const request = JSON.stringify({ type: 'api-request', params: { model: 'opus', max_tokens: 16000 } });
    const reply = JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), version: '2', perTurnEffort: 'high',
      message: { id: 'imported', model: 'opus', usage: { output_tokens: 10, output_tokens_details: { thinking_tokens: 5 } } } });
    writeFileSync(file, `${request}\n${reply}\n`, 'utf8');
    const e = parseClientLine(reply, 'claude', {})!;
    log.importBatch(file, '{"version":2}', [{ ...e, thinkingTokens: null, clientVersion: null, reasoningEffort: null }]);
    const totals = log.totalsList();
    log.close();
    const db = openActivityDb(config.activityDb, config.databaseKey);
    db.prepare("DELETE FROM meta WHERE key = 'client-log-drift-metadata-backfilled'").run();
    db.close();
    log = new ActivityLog(config);
    expect(log.checkpoint(file)).toBeUndefined();
    await importClientFile(file, 'claude', log);
    expect(log.totalsList()).toEqual(totals);
    expect(log.day(localDay(Date.now()))).toHaveLength(1);
    expect(log.day(localDay(Date.now()))[0]).toMatchObject(metadata);
    expect(log.day(localDay(Date.now()))[0]).not.toHaveProperty('requestSettings');
    const checkpoint = log.checkpoint(file);
    log.close(); log = new ActivityLog(config);
    expect(log.checkpoint(file)).toBe(checkpoint);
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
});

it.each([false, true])('relinks transcript-first metadata replays (historical repair: %s)', (historical) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'spillway-relink-'));
  const config = { activityDb: path.join(dir, 'a.db'), legacyActivityDir: path.join(dir, 'legacy'), databaseKey: 'ab'.repeat(32), retentionDays: 365 };
  let log = new ActivityLog(config);
  try {
    const proxy = parseActivityEvent(JSON.stringify({ at: new Date().toISOString(), request_id: 'proxy', upstream_id: 'response', provider: 'claude', model: 'opus', output_tokens: 10 }))!;
    const transcript = { ...proxy, requestId: 'transcript', source: 'client-log' as const };
    const original = log.append(transcript)!;
    for (const requestId of ['unrelated-a', 'unrelated-b']) log.append({ ...proxy, requestId, upstreamId: requestId });
    const surviving = log.append(proxy)!;
    expect(surviving.id).not.toBe(original.id);
    const totals = log.totalsList();
    if (historical) {
      log.close();
      const db = openActivityDb(config.activityDb, config.databaseKey);
      db.prepare('UPDATE usage_identities SET row_id = ? WHERE key = ?').run(original.id, 'client-log:transcript');
      db.prepare("DELETE FROM meta WHERE key = 'client-log-drift-metadata-backfilled'").run();
      db.close();
      log = new ActivityLog(config);
    }
    const metadata = { thinkingTokens: 7, clientVersion: '2', settingsHash: 'settings', reasoningEffort: 'high' };
    log.append({ ...transcript, ...metadata });
    const rows = log.day(localDay(Date.now()));
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.requestId === 'proxy')).toMatchObject({ id: surviving.id, ...metadata });
    expect(log.totalsList()).toEqual(totals);
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
});

it.each([false, true])('keeps reused request IDs untouched on transcript replay (matched: %s)', (matched) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'spillway-reused-replay-'));
  const config = { activityDb: path.join(dir, 'a.db'), legacyActivityDir: path.join(dir, 'legacy'), databaseKey: 'ab'.repeat(32), retentionDays: 365 };
  const log = new ActivityLog(config);
  try {
    const proxy = parseActivityEvent(JSON.stringify({ at: new Date().toISOString(), request_id: 'expired', upstream_id: 'expired-response', provider: 'claude', model: 'opus', output_tokens: 10 }))!;
    const transcript = { ...proxy, requestId: 'transcript', source: 'client-log' as const };
    if (matched) log.append(proxy);
    const original = log.append(transcript)!;
    log.close();
    const db = openActivityDb(config.activityDb, config.databaseKey);
    db.exec('DELETE FROM requests');
    db.close();
    const current = log.append({ ...proxy, requestId: 'current', upstreamId: 'current-response' })!;
    expect(current.id).toBe(original.id);
    const before = log.day(localDay(Date.now()));
    log.append({ ...transcript, thinkingTokens: 7, clientVersion: 'expired-version', settingsHash: 'expired-settings', reasoningEffort: 'high' });
    expect(log.day(localDay(Date.now()))).toEqual(before);
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
});

it.each([[false, false], [false, true], [true, true]])('repairs transcript links only to owned proxy rows (proxy retained: %s, transcript ID reused: %s)', (proxyRetained, transcriptReused) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'spillway-reused-repair-'));
  const config = { activityDb: path.join(dir, 'a.db'), legacyActivityDir: path.join(dir, 'legacy'), databaseKey: 'ab'.repeat(32), retentionDays: 365 };
  const log = new ActivityLog(config);
  try {
    const proxy = parseActivityEvent(JSON.stringify({ at: new Date().toISOString(), request_id: 'proxy', upstream_id: 'response', provider: 'claude', model: 'opus', output_tokens: 10 }))!;
    const transcript = { ...proxy, requestId: 'transcript', source: 'client-log' as const };
    log.append(proxy);
    log.append(transcript);
    log.close();
    let db = openActivityDb(config.activityDb, config.databaseKey);
    db.exec('DELETE FROM requests');
    db.close();
    const unrelated = log.append({ ...proxy, requestId: 'current', upstreamId: 'current-response' })!;
    log.close();
    db = openActivityDb(config.activityDb, config.databaseKey);
    let target = unrelated.id;
    if (proxyRetained) target = Number(db.prepare('INSERT INTO requests (day, failed, event) VALUES (?, 0, ?)').run(localDay(Date.now()), JSON.stringify(proxy)).lastInsertRowid);
    db.prepare("UPDATE usage_identities SET row_id = ? WHERE source = 'proxy' AND upstream_id = 'response'").run(target);
    db.prepare("UPDATE usage_identities SET row_id = ? WHERE key = 'client-log:transcript'").run(transcriptReused ? unrelated.id : 0);
    db.prepare("DELETE FROM meta WHERE key = 'client-log-drift-metadata-backfilled'").run();
    db.close();
    db = openActivityDb(config.activityDb, config.databaseKey);
    expect(db.prepare("SELECT row_id FROM usage_identities WHERE key = 'client-log:transcript'").get()).toEqual({ row_id: proxyRetained ? target : transcriptReused ? unrelated.id : 0 });
    db.close();
    const before = log.day(localDay(Date.now())).find((row) => row.requestId === 'current');
    const metadata = { thinkingTokens: 7, clientVersion: 'replayed', settingsHash: 'settings', reasoningEffort: 'high' };
    log.append({ ...transcript, ...metadata });
    const rows = log.day(localDay(Date.now()));
    expect(rows.find((row) => row.requestId === 'current')).toEqual(before);
    if (proxyRetained) expect(rows.find((row) => row.requestId === 'proxy')).toMatchObject(metadata);
  } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
});
