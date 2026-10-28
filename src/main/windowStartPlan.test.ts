import { describe, expect, it } from 'vitest';
import type { Credential, LimitWindow, UsageSnapshot } from '@shared/types';
import { DEFAULT_WINDOW_START, type WindowStartSettings } from '@shared/windowStartSettings';
import { dueForWindowStart } from './windowStartPlan';

const HOUR = 3_600_000;
const FIVE_HOURS = 5 * HOUR;
const NOW = new Date('2026-10-27T12:00:00Z');
const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

const session = (resetsInMs: number | null): LimitWindow => ({
  key: 'five_hour', label: '5-hour', usedPercent: resetsInMs === null ? 0 : 10, resetsAt: resetsInMs === null ? null : iso(resetsInMs),
  status: 'allowed', durationMs: FIVE_HOURS, scoped: false, resetCadence: 'on_use',
});

const weekly = (status: LimitWindow['status']): LimitWindow => ({
  key: 'seven_day', label: 'Weekly', usedPercent: 50, resetsAt: iso(48 * HOUR), status, durationMs: 168 * HOUR, scoped: false, resetCadence: 'fixed',
});

function cred(id: string, windows: LimitWindow[], extra: Partial<Credential> = {}): Credential {
  return {
    id, name: `${id}.json`, authIndex: `idx-${id}`, provider: 'claude', label: id, note: null, email: null, lastUsedAt: null,
    disabled: false, status: 'active', statusMessage: null, priority: 0, cooldownUntil: null, observedAt: null, nextPick: false,
    preferred: false, weight: 1, plan: null, resetCredits: null, windows, ...extra,
  };
}

const snap = (...credentials: Credential[]): UsageSnapshot => ({ fetchedAt: NOW.toISOString(), strategy: 'soonest-reset', credentials });
const on: WindowStartSettings = { ...DEFAULT_WINDOW_START, enabled: true };
const ids = (cs: Credential[]) => cs.map((c) => c.id);

describe('dueForWindowStart', () => {
  it('starts idle 5-hour windows and leaves running ones', () => {
    const due = dueForWindowStart(snap(cred('idle', [session(null)]), cred('busy', [session(HOUR)]), cred('past', [session(-HOUR)])), on, NOW, new Map());
    expect(ids(due)).toEqual(['idle', 'past']);
  });

  it('does nothing when off or outside active hours', () => {
    const s = snap(cred('idle', [session(null)]));
    expect(dueForWindowStart(s, DEFAULT_WINDOW_START, NOW, new Map())).toEqual([]);
    const hour = NOW.getHours() * 60;
    const closed = { ...on, activeHours: { enabled: true, startMinute: (hour + 60) % 1440, endMinute: (hour + 120) % 1440 } };
    expect(dueForWindowStart(s, closed, NOW, new Map())).toEqual([]);
  });

  it('skips API keys, disabled, cooling, weekly-limited, unknown-cadence and other providers', () => {
    const due = dueForWindowStart(snap(
      cred('key', [session(null)], { apiKey: { masked: 'sk…', success: 0, failed: 0 } }),
      cred('off', [session(null)], { disabled: true }),
      cred('cool', [session(null)], { cooldownUntil: iso(HOUR) }),
      cred('weekly', [session(null), weekly('rejected')]),
      cred('unknown', [{ ...session(null), resetCadence: null }]),
      cred('gem', [session(null)], { provider: 'gemini' }),
      cred('ok', [session(null), weekly('allowed_warning')]),
    ), on, NOW, new Map());
    expect(ids(due)).toEqual(['ok']);
  });

  it('does not restart a window the app started before the proxy reports it', () => {
    const s = snap(cred('idle', [session(null)]));
    expect(dueForWindowStart(s, on, NOW, new Map([['idle', NOW.getTime() - HOUR]]))).toEqual([]);
    expect(ids(dueForWindowStart(s, on, NOW, new Map([['idle', NOW.getTime() - FIVE_HOURS]])))).toEqual(['idle']);
  });

  it('spaces starts by window length over account count when staggered', () => {
    const spaced = { ...on, stagger: true };
    // Two idle accounts: only one starts per pass.
    expect(ids(dueForWindowStart(snap(cred('a', [session(null)]), cred('b', [session(null)])), spaced, NOW, new Map()))).toEqual(['a']);
    // Spacing is 2.5 h; the other window started 2 h ago (resets in 3 h), so wait.
    expect(dueForWindowStart(snap(cred('a', [session(3 * HOUR)]), cred('b', [session(null)])), spaced, NOW, new Map())).toEqual([]);
    // Started 3 h ago (resets in 2 h): far enough apart.
    expect(ids(dueForWindowStart(snap(cred('a', [session(2 * HOUR)]), cred('b', [session(null)])), spaced, NOW, new Map()))).toEqual(['b']);
    // Providers are spaced independently.
    const codex = cred('c', [session(null)], { provider: 'codex' });
    expect(ids(dueForWindowStart(snap(cred('a', [session(4 * HOUR)]), cred('b', [session(null)]), codex), spaced, NOW, new Map()))).toEqual(['c']);
  });
});
