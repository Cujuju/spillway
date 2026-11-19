import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, expect, it } from 'vitest';
import { localDay } from '@shared/activityCounts';
import { inScope, normalizeScope, type ActivityScope } from '@shared/activityScope';
import { currentRates, tokenCost } from '@shared/modelPrices';
import { LIGHT_THINKING_MAX, MIN_RATIO_TURNS, THINKING_BUCKETS, TURN_KINDS, TYPICAL_THINKING_MAX, settingKey, type Alternative, type ThinkingQuery, type ThinkingReport, type ThinkingSetting, type TurnKind } from '@shared/thinking';
import type { ActivityEvent } from '@shared/types';
import { openKeyed, type Db } from './activityDb';
import { ActivityLog } from './activityStore';
import { kind, setting, type OfferedModel } from './activityThinking';
import { dayWindow, group, RETAINED_TURNS_SQL, type Request, type Turn } from './retainedTurns';
import { identityKey, identityKeySql } from './usageLedger';
import { thinkingEvent as event } from './activityThinkingFixtures';

const KEY = 'ab'.repeat(32);
const dir = mkdtempSync(path.join(tmpdir(), 'spillway-thinking-equivalence-'));
let log: ActivityLog, file: string, other: Db, sequence = 0;
beforeEach(() => {
  file = path.join(dir, `${sequence++}.db`);
  log = new ActivityLog({ activityDb: file, legacyActivityDir: path.join(dir, 'absent'), databaseKey: KEY, retentionDays: 30 });
  log.days();
  other = openKeyed(file, KEY);
});
afterEach(() => { other.close(); log.close(); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The report as it was before #158: every request read, one identity lookup each, every estimate recomputed. The report must equal it exactly. */
function oracle(db: Db, raw: ThinkingQuery, models: OfferedModel[]): ThinkingReport {
  const EFFORTS = ['ultra', 'max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'];
  const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((n, x) => n + f(x), 0);
  const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b), mid = Math.floor(s.length / 2); return s.length ? s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2 : 0; };
  const cost = (e: Request) => e.costUsd ?? tokenCost(e.provider, e.effectiveModel ?? e.model, e.at, { ...e, cacheWriteTokens: e.cacheWriteTokens ?? 0 })?.usd ?? 0;
  const counts = (e: Request) => ({ ...e, cacheWriteTokens: e.cacheWriteTokens ?? 0 });
  const thinkingCost = (e: Request) => {
    const t = counts(e), model = e.effectiveModel ?? e.model;
    const full = tokenCost(e.provider, model, e.at, t);
    const visible = tokenCost(e.provider, model, e.at, { ...t, outputTokens: e.outputTokens - (e.thinkingTokens ?? 0) });
    return full && visible ? full.usd - visible.usd : 0;
  };
  const thinking = (t: Turn) => sum(t.requests, (e) => e.thinkingTokens ?? 0);
  const turnCost = (t: Turn) => sum(t.requests, cost);
  const bucket = (t: Turn) => thinking(t) <= LIGHT_THINKING_MAX ? 'light' : thinking(t) <= TYPICAL_THINKING_MAX ? 'typical' : 'heavy';
  const q = { from: raw.from, to: raw.to, scope: normalizeScope(raw.scope) };
  const identity = db.prepare('SELECT event FROM usage_identities WHERE key = ? AND row_id = ?');
  const requests = (db.prepare("SELECT id, event FROM requests ORDER BY julianday(json_extract(event, '$.at')), id").all() as { id: number; event: string }[])
    .map((r) => {
      const event = JSON.parse(r.event) as Request;
      const ledger = identity.get(identityKey(event), r.id) as { event: string } | undefined;
      const stored = ledger ? JSON.parse(ledger.event) as Request : null;
      return { ...event, ...(stored?.costUsd !== undefined ? { costUsd: stored.costUsd } : {}) };
    });
  const { turns: all, excluded } = group(requests);
  const inTime = (e: Request) => Date.parse(e.at) >= q.from && Date.parse(e.at) <= q.to;
  const untracked = { requests: 0, costUsd: 0 };
  const omit = (e: Request) => { untracked.requests++; untracked.costUsd += cost(e); };
  for (const e of excluded) if (inTime(e) && inScope(q.scope, e)) omit(e);
  const turns: Turn[] = [];
  for (const t of all) {
    if (!inTime(t.first)) continue;
    const scoped = t.requests.filter((e) => inScope(q.scope, e));
    for (const e of scoped) if (!e.turnKey || !EFFORTS.includes(e.reasoningEffort ?? '') || !EFFORTS.includes(t.first.reasoningEffort ?? '')) omit(e);
    const tracked = scoped.filter((e) => e.turnKey && EFFORTS.includes(e.reasoningEffort ?? '') && EFFORTS.includes(t.first.reasoningEffort ?? ''));
    if (tracked.length) turns.push({ first: t.first, requests: tracked });
  }
  const days = [...new Set(turns.map((t) => localDay(Date.parse(t.first.at))))].sort();
  const factor = days.length ? 7 / days.length : 0;
  const groups = new Map<string, Turn[]>();
  for (const t of turns) { const key = settingKey(setting(t.first)), own = groups.get(key) ?? []; own.push(t); groups.set(key, own); }
  const settings = [...groups.values()].map((own) => {
    const s = setting(own[0]!.first), total = sum(own, turnCost), tc = sum(own, (t) => sum(t.requests, thinkingCost));
    const observed = new Set(turns.filter((t) => t.first.provider === s.provider).map((t) => t.first.reasoningEffort));
    const lower = EFFORTS.slice(EFFORTS.indexOf(s.effort) + 1).filter((effort) => observed.has(effort) || effort === 'medium');
    const ratios = new Map<string, number | null>();
    const ratio = (effort: string, k?: TurnKind): number | null => {
      const key = JSON.stringify([effort, k ?? null]);
      if (ratios.has(key)) return ratios.get(key)!;
      const measured = (t: Turn) => t.requests.every((e) => e.thinkingTokens != null);
      const a = own.filter((t) => measured(t) && (!k || kind(t) === k));
      const b = (groups.get(settingKey({ ...s, effort })) ?? []).filter((t) => measured(t) && (!k || kind(t) === k));
      const denominator = median(a.map(thinking));
      const value = a.length < MIN_RATIO_TURNS || b.length < MIN_RATIO_TURNS ? k ? ratio(effort) : null
        : denominator > 0 ? Math.min(median(b.map(thinking)) / denominator, 1) : null;
      ratios.set(key, value);
      return value;
    };
    const estimate = (t: Turn, effort: string) => {
      if (t.requests.some((e) => e.thinkingTokens == null || !currentRates(e.effectiveModel ?? e.model))) return null;
      const r = ratio(effort, kind(t));
      return r === null ? null : turnCost(t) - sum(t.requests.filter((e) => settingKey(setting(e)) === settingKey(s)), thinkingCost) * (1 - r);
    };
    const alternative = (target: ThinkingSetting, method: Alternative['method'], values: (number | null)[], reason: Alternative['reason'] = 'not-enough-data'): Alternative => {
      if (values.some((v) => v === null)) return { setting: target, method, costUsdPerWeek: null, savingUsdPerWeek: null, savingShare: null, medianTurnCostUsd: null, reason };
      const costs = values as number[], estimated = sum(costs, (v) => v);
      return { setting: target, method, costUsdPerWeek: estimated * factor, savingUsdPerWeek: (total - estimated) * factor, savingShare: total ? (total - estimated) / total : 0, medianTurnCostUsd: median(costs), reason: null };
    };
    const alternatives = lower.map((effort) => alternative({ ...s, effort }, 'effort-ratio', own.map((t) => estimate(t, effort)), currentRates(s.model) ? 'not-enough-data' : 'unpriced'));
    const base = currentRates(s.model);
    const candidates = [...new Map(models.filter((m) => m.provider === s.provider && m.id !== s.model).map((m) => [m.id, m])).values()]
      .filter((m) => { const r = currentRates(m.id); return base && r && r.input < base.input && r.output < base.output; });
    const kept = candidates.filter((m) => !candidates.some((o) => {
      const a = currentRates(m.id)!, b = currentRates(o.id)!;
      return m.created != null && o.created != null && o.created > m.created && b.input <= a.input && b.output <= a.output;
    })).sort((a, b) => currentRates(b.id)!.output - currentRates(a.id)!.output).slice(0, 3);
    for (const m of kept) alternatives.push(alternative({ ...s, model: m.id }, 'reprice', own.map((t) => {
      let estimated = turnCost(t);
      for (const e of t.requests) {
        if (settingKey(setting(e)) !== settingKey(s)) continue;
        const priced = tokenCost(e.provider, m.id, e.at, counts(e));
        if (!priced) return null;
        estimated += priced.usd - cost(e);
      }
      return estimated;
    }), 'unpriced'));
    const mixedEffort = lower.find((effort) => ratio(effort, 'question') !== null && ratio(effort, 'change') !== null && own.every((t) => kind(t) === 'long' || estimate(t, effort) !== null));
    if (mixedEffort) alternatives.push(alternative({ ...s, effort: mixedEffort }, 'mixed', own.map((t) => kind(t) === 'long' ? turnCost(t) : estimate(t, mixedEffort))));
    return {
      setting: s, turns: own.length, costUsd: total, costUsdPerWeek: total * factor, thinkingCostUsd: tc, thinkingShare: total ? tc / total : 0, medianTurnCostUsd: median(own.map(turnCost)),
      buckets: THINKING_BUCKETS.map((b) => { const selected = own.filter((t) => bucket(t) === b), thinkingCostUsd = sum(selected, (t) => sum(t.requests, thinkingCost)); return { bucket: b, turns: selected.length, turnShare: selected.length / own.length, thinkingCostUsd, thinkingCostShare: tc ? thinkingCostUsd / tc : 0 }; }),
      kinds: TURN_KINDS.map((k) => {
        const selected = own.filter((t) => kind(t) === k), costUsd = sum(selected, turnCost);
        const effort = lower.find((e) => selected.length > 0 && selected.every((t) => estimate(t, e) !== null));
        return { kind: k, turns: selected.length, costUsd, costShare: total ? costUsd / total : 0, thinkingShare: costUsd ? sum(selected, (t) => sum(t.requests, thinkingCost)) / costUsd : 0,
          lowerEffortSavingUsdPerWeek: effort ? sum(selected, (t) => turnCost(t) - estimate(t, effort)!) * factor : null };
      }), alternatives,
    };
  }).sort((a, b) => b.costUsd - a.costUsd);
  return { coveredFrom: days[0] ?? null, coveredTo: days.at(-1) ?? null, coveredDays: days.length, settings, untracked };
}

const MINUTE_MS = 60_000, HOUR_MS = 60 * MINUTE_MS, DAY_MS = 24 * HOUR_MS;
// Enough trees that every random range cuts through several turns and subagents.
const SEEDED_SESSIONS = 30;
const MIN_SEEDED_REQUESTS = 300;
// Each test compares about fifty reports against the full-table oracle; allow for a contended runner, as vitest.config.ts does.
const SEEDED_TEST_TIMEOUT_MS = 30_000;
const now = Date.now();
/** mulberry32, so a failure reproduces. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296; };
}
const MODELS: OfferedModel[] = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-sonnet-4-6'].map((id, created) => ({ id, provider: 'claude', created }));
const SCOPES: ActivityScope[] = [{ accounts: null, clients: null }, { accounts: ['a'], clients: null }, { accounts: null, clients: ['sdk'], source: 'proxy' }];

/** Six days of session trees whose turns, subagents and compactions run across any range edge. */
function seed(rand: () => number): number[] {
  const planned: { at: number; patch: Partial<ActivityEvent>; costUsd?: number }[] = [];
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const plan = (at: number, patch: Partial<ActivityEvent>) => {
    const thinkingTokens = rand() < 0.1 ? null : Math.floor(rand() * 30_000);
    planned.push({ at, patch: { thinkingTokens, outputTokens: 500 + (thinkingTokens ?? 0), authIndex: pick(['a', 'a', 'b', null]), client: pick(['cli', 'sdk']),
      ...patch, ...(rand() < 0.05 ? { reasoningEffort: null } : {}) }, ...(rand() < 0.3 ? { costUsd: rand() * 3 } : {}) });
  };
  for (let s = 0; s < SEEDED_SESSIONS; s++) {
    const root = `root${s}`, [model, effort] = pick([['claude-opus-5-5', 'high'], ['claude-opus-5-5', 'medium'], ['claude-sonnet-5-5', 'medium']] as const);
    const base = { sessionId: root, sessionKind: 'root' as const, model, effectiveModel: model, reasoningEffort: effort };
    let at = now - 6 * DAY_MS + rand() * 5.5 * DAY_MS;
    for (let turn = 0, turns = 1 + Math.floor(rand() * 6); turn < turns; turn++) {
      // Keys repeat after a gap, which starts a new turn.
      const turnKey = `${root}:${Math.floor(rand() * 3)}`;
      for (let n = 0, size = 1 + Math.floor(rand() * 20); n < size; n++) {
        at += rand() < 0.8 ? rand() * MINUTE_MS : rand() * 3 * HOUR_MS;
        plan(at, { ...base, turnKey: rand() < 0.08 ? null : turnKey });
      }
      if (rand() < 0.4) {
        const child = `${root}:agent${turn}`;
        let childAt = at - rand() * HOUR_MS;
        for (let n = 0, size = 1 + Math.floor(rand() * 8); n < size; n++) {
          // Half the subagents name their parent on the first request only.
          plan(childAt, { sessionId: child, sessionKind: 'subagent', parentSessionId: n === 0 || s % 2 ? root : null, turnKey: `${child}:t`, model: 'claude-haiku-5-5', effectiveModel: 'claude-haiku-5-5', reasoningEffort: 'low' });
          childAt += rand() * 12 * HOUR_MS;
        }
        if (rand() < 0.3) plan(childAt, { sessionId: `${child}:nested`, sessionKind: 'subagent', parentSessionId: child, turnKey: 'nested', reasoningEffort: 'high' });
      }
      if (rand() < 0.15) plan(at + rand() * DAY_MS, { ...base, sessionId: `${root}:compact${turn}`, sessionKind: 'compaction', parentSessionId: rand() < 0.8 ? root : null, turnKey: 'compact' });
      if (rand() < 0.1) plan(at + rand() * HOUR_MS, { ...base, sessionId: `${root}:fork${turn}`, sessionKind: 'fork', parentSessionId: root, turnKey: 'fork' });
    }
    if (rand() < 0.1) plan(at, { sessionId: `orphan${s}`, sessionKind: 'subagent', parentSessionId: `absent${s}`, turnKey: 'orphan', reasoningEffort: 'high' });
    if (rand() < 0.3) plan(at + rand() * HOUR_MS, { turnKey: 'sessionless', reasoningEffort: 'high' });
  }
  // Mostly recorded in time order; the rest prove the report orders by time, not row id.
  planned.sort((a, b) => a.at - b.at + (rand() < 0.1 ? (rand() - 0.5) * HOUR_MS : 0));
  // One transaction: a commit per request would dominate the test.
  log.importEvents(planned.filter((p) => p.at <= now).map((p) => ({ ...event(Math.floor(p.at), p.patch), ...(p.costUsd === undefined ? {} : { costUsd: p.costUsd, uncachedCostUsd: p.costUsd }) })));
  return planned.map((p) => Math.floor(p.at)).filter((at) => at <= now);
}

/** Ranges that start and end on, and one millisecond around, real requests. */
function ranges(times: number[], rand: () => number): [number, number][] {
  const edge = () => times[Math.floor(rand() * times.length)]! + Math.floor(rand() * 3) - 1;
  const random = Array.from({ length: 12 }, () => { const a = edge(), b = edge(); return [Math.min(a, b), Math.max(a, b)] as [number, number]; });
  return [[now - HOUR_MS, now], [0, now], [now - 6 * DAY_MS, now - 5 * DAY_MS], [-1e15, 8e15], [now - 30 * DAY_MS, now - 20 * DAY_MS], ...random];
}
function expectSameReports(times: number[], rand: () => number): void {
  for (const [from, to] of ranges(times, rand)) {
    for (const scope of SCOPES) expect(log.thinking({ scope, from, to }, MODELS), `${from}..${to} ${JSON.stringify(scope)}`).toStrictEqual(oracle(other, { scope, from, to }, MODELS));
  }
}

it.each([1, 2, 3])('matches the full-table report for ranges that cut through turns and subagents (seed %i)', { timeout: SEEDED_TEST_TIMEOUT_MS }, (n) => {
  const rand = rng(n), times = seed(rand);
  expect(times.length).toBeGreaterThan(MIN_SEEDED_REQUESTS);
  expectSameReports(times, rand);
});

it('keeps a turn whole when its start, its end and its subagents lie days outside the range', () => {
  const root = { sessionId: 'root', sessionKind: 'root' as const, thinkingTokens: 100 };
  const agent = { sessionKind: 'subagent' as const, thinkingTokens: 100, turnKey: 'agent' };
  log.importEvents([
    // Starts three days before the range and runs into it: no part of it counts.
    event(now - 8 * DAY_MS, { ...root, turnKey: 'early' }), event(now - 5 * DAY_MS, { ...root, turnKey: 'early' }),
    // Starts inside the range; its own tail, a subagent and that subagent's subagent all run days later.
    event(now - 5 * DAY_MS + MINUTE_MS, { ...root, turnKey: 'inside' }), event(now - 2 * DAY_MS, { ...root, turnKey: 'inside' }),
    event(now - 3 * DAY_MS, { ...agent, sessionId: 'child', parentSessionId: 'root' }),
    event(now - DAY_MS, { ...agent, sessionId: 'grandchild', parentSessionId: 'child' }),
    // Starts after the range.
    event(now - HOUR_MS, { ...root, turnKey: 'late' }),
  ]);
  const q = { scope: SCOPES[0]!, from: now - 5 * DAY_MS - HOUR_MS, to: now - 5 * DAY_MS + HOUR_MS };
  const report = log.thinking(q, MODELS)!;
  expect(report).toStrictEqual(oracle(other, q, MODELS));
  expect(report.settings).toHaveLength(1);
  expect(report.settings[0]).toMatchObject({ turns: 1, kinds: [{ kind: 'question', turns: 0 }, { kind: 'change', turns: 0 }, { kind: 'long', turns: 1 }] });
  expect(report.settings[0]!.costUsd).toBeCloseTo(tokenCost('claude', 'claude-opus-5-5', now, event(now, {}))!.usd * 4);
  expect(report.untracked.requests).toBe(0);
});

it('finds requests whose day was stored in another time zone', { timeout: SEEDED_TEST_TIMEOUT_MS }, () => {
  const rand = rng(4), times = seed(rand);
  // The same instants as recorded in UTC+14 and UTC-12, the widest zone offsets.
  const shift = other.prepare('UPDATE requests SET day = ? WHERE id = ?');
  const rows = other.prepare("SELECT id, json_extract(event, '$.at') AS at FROM requests").all() as { id: number; at: string }[];
  other.transaction(() => {
    for (const r of rows) shift.run(new Date(Date.parse(r.at) + (r.id % 2 ? 14 : -12) * HOUR_MS).toISOString().slice(0, 10), r.id);
  })();
  expectSameReports(times, rand);
});

it('reuses loaded turns only until the database changes', { timeout: SEEDED_TEST_TIMEOUT_MS }, () => {
  const rand = rng(5), times = seed(rand);
  const wide = { scope: SCOPES[0]!, from: now - 6 * DAY_MS, to: now }, narrow = { ...wide, from: now - HOUR_MS };
  const before = log.thinking(wide, MODELS)!;
  expect(log.thinking(narrow, MODELS)).toStrictEqual(oracle(other, narrow, MODELS));
  // This connection's write.
  log.append(event(now - MINUTE_MS, { sessionId: 'late', sessionKind: 'root', turnKey: 'late', thinkingTokens: 5 }));
  const appended = log.thinking(wide, MODELS)!;
  expect(appended).toStrictEqual(oracle(other, wide, MODELS));
  expect(appended.settings.reduce((turns, s) => turns + s.turns, 0)).toBe(before.settings.reduce((turns, s) => turns + s.turns, 0) + 1);
  // Another connection's write.
  other.prepare("DELETE FROM requests WHERE json_extract(event, '$.sessionId') = 'late'").run();
  expect(log.thinking(wide, MODELS)).toStrictEqual(before);
  expectSameReports(times, rand);
});

it('builds the identity key in SQL exactly as identityKey does', () => {
  log.append(event(now - MINUTE_MS, { authIndex: null }));
  log.append(event(now - MINUTE_MS, { authIndex: 'a:b' }));
  log.append(event(now - MINUTE_MS, { source: 'client-log', upstreamId: 'msg_1', sessionId: 's' }));
  const rows = other.prepare(`SELECT event, ${identityKeySql('event')} AS key FROM requests`).all() as { event: string; key: string }[];
  expect(rows).toHaveLength(3);
  for (const r of rows) expect(r.key).toBe(identityKey(JSON.parse(r.event) as ActivityEvent));
});

it('reads the window and its session trees through indexes', () => {
  const params = { inWindow: ['', ''], sessionSizes: ['[]'], restOfSessions: ['[]', '', ''], childSessions: ['[]'], changedRows: ['[]'] };
  for (const [name, sql] of Object.entries(RETAINED_TURNS_SQL)) {
    const plan = (other.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params[name as keyof typeof params]) as { detail: string }[]).map((r) => r.detail).join('\n');
    expect(plan, name).not.toMatch(/SCAN (requests|i)\b/);
    if (name === 'sessionSizes') expect(plan, name).toContain('COVERING INDEX');
  }
});

it('covers every zone a day could have been stored in, and every day outside four-digit years', () => {
  const noon = Date.UTC(2026, 5, 10, 12);
  expect(dayWindow(noon, noon)).toEqual({ from: '2026-06-10', to: '2026-06-11' });
  expect(dayWindow(noon - HOUR_MS, noon - HOUR_MS)).toEqual({ from: '2026-06-09', to: '2026-06-11' });
  expect(dayWindow(-1e15, noon)).toEqual({ from: '', to: '\uffff' });
  expect(dayWindow(noon, 8e15)).toEqual({ from: '', to: '\uffff' });
});
