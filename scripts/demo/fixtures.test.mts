import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { MIN_RATIO_TURNS } from '../../src/shared/thinking.ts';
import { openActivityDb } from '../../src/main/activityDb.ts';
import { thinkingActivity } from '../../src/main/activityThinking.ts';
import { localDay } from '../../src/shared/activityCounts.ts';
import { parseActivityEvent } from '../../src/main/sse.ts';
import { generate } from './fixtures.mts';

it('estimates Opus high in every kind and preserves a setting without enough comparison data', () => {
  const now = new Date(2026, 10, 11, 18).getTime(), data = generate(now);
  const dir = mkdtempSync(path.join(tmpdir(), 'spillway-fixtures-'));
  const db = openActivityDb(path.join(dir, 'activity.db'), 'ab'.repeat(32));
  try {
    const insert = db.prepare('INSERT INTO requests (day, failed, event) VALUES (?, ?, ?)');
    db.transaction(() => { for (const e of data.events) { const event = parseActivityEvent(JSON.stringify(e))!; insert.run(localDay(Date.parse(event.at)), event.failed ? 1 : 0, JSON.stringify(event)); } })();
    const report = thinkingActivity(db, { from: Date.parse(data.events[0]!.at), to: now, scope: { accounts: null, clients: null } }, [])!;
    const high = report.settings[0]!;
    expect(high.setting).toEqual({ provider: 'claude', model: 'claude-opus-5-5', effort: 'high' });
    const [light, typical, heavy] = high.buckets;
    expect(light!.turnShare).toBeGreaterThanOrEqual(0.55); expect(light!.turnShare).toBeLessThanOrEqual(0.60);
    expect(typical!.turnShare).toBeGreaterThan(0.25); expect(typical!.turnShare).toBeLessThan(0.35);
    expect(heavy!.turnShare).toBeGreaterThan(0.07); expect(heavy!.turnShare).toBeLessThan(0.13);
    expect(heavy!.thinkingCostShare).toBeGreaterThan(0.5);
    expect(high.thinkingShare).toBeGreaterThanOrEqual(0.30); expect(high.thinkingShare).toBeLessThanOrEqual(0.45);
    const medium = report.settings.find((s) => s.setting.model === high.setting.model && s.setting.effort === 'medium')!;
    for (const s of [high, medium]) for (const k of s.kinds) expect(k.turns).toBeGreaterThanOrEqual(MIN_RATIO_TURNS);
    for (const k of high.kinds) expect(k.lowerEffortSavingUsdPerWeek).toBeGreaterThan(0);
    expect(high.alternatives.find((a) => a.method === 'mixed')).toMatchObject({ setting: { effort: 'medium' }, reason: null });
    const codex = report.settings.find((s) => s.setting.model === 'gpt-6.1-sol')!;
    expect(codex.alternatives.find((a) => a.setting.effort === 'medium')).toMatchObject({ reason: 'not-enough-data' });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
