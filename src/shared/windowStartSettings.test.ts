import { describe, expect, it } from 'vitest';
import { DEFAULT_WINDOW_START, minuteToTime, normalizeWindowStart, timeToMinute, withinActiveHours } from './windowStartSettings';

const at = (h: number, m = 0) => new Date(2026, 9, 27, h, m);

describe('normalizeWindowStart', () => {
  it('fills defaults and drops invalid values', () => {
    expect(normalizeWindowStart(undefined)).toEqual(DEFAULT_WINDOW_START);
    const n = normalizeWindowStart({ enabled: true, models: { claude: ' claude-haiku-5-5 ', codex: 7 }, activeHours: { enabled: true, startMinute: 1440, endMinute: 90.5 }, stagger: 'yes' });
    expect(n).toEqual({
      enabled: true,
      models: { claude: 'claude-haiku-5-5', codex: '' },
      activeHours: { enabled: true, startMinute: DEFAULT_WINDOW_START.activeHours.startMinute, endMinute: DEFAULT_WINDOW_START.activeHours.endMinute },
      stagger: false,
    });
  });
});

describe('withinActiveHours', () => {
  it('is always true when off or when start equals end', () => {
    expect(withinActiveHours({ enabled: false, startMinute: 600, endMinute: 660 }, at(3))).toBe(true);
    expect(withinActiveHours({ enabled: true, startMinute: 600, endMinute: 600 }, at(3))).toBe(true);
  });

  it('checks a same-day range with an exclusive end', () => {
    const day = { enabled: true, startMinute: 8 * 60, endMinute: 23 * 60 };
    expect(withinActiveHours(day, at(8))).toBe(true);
    expect(withinActiveHours(day, at(22, 59))).toBe(true);
    expect(withinActiveHours(day, at(23))).toBe(false);
    expect(withinActiveHours(day, at(7, 59))).toBe(false);
  });

  it('wraps past midnight when the end is before the start', () => {
    const night = { enabled: true, startMinute: 22 * 60, endMinute: 2 * 60 };
    expect(withinActiveHours(night, at(23))).toBe(true);
    expect(withinActiveHours(night, at(1, 30))).toBe(true);
    expect(withinActiveHours(night, at(12))).toBe(false);
  });
});

describe('time fields', () => {
  it('round-trips HH:MM and rejects malformed text', () => {
    expect(minuteToTime(8 * 60 + 5)).toBe('08:05');
    expect(timeToMinute('23:59')).toBe(23 * 60 + 59);
    expect(timeToMinute('24:00')).toBeNull();
    expect(timeToMinute('07:60')).toBeNull();
    expect(timeToMinute('7:00')).toBeNull();
  });
});
