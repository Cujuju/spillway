import { describe, expect, it } from 'vitest';
import { periodKey, periodLabel } from './totalsPeriod';

describe('periodKey', () => {
  it('keeps days and truncates months and years', () => {
    expect(periodKey('2026-11-06', 'day')).toBe('2026-11-06');
    expect(periodKey('2026-11-06', 'month')).toBe('2026-11');
    expect(periodKey('2026-11-06', 'year')).toBe('2026');
  });

  it('maps every day of a week to its Monday', () => {
    for (const day of ['2026-11-02', '2026-11-04', '2026-11-08']) expect(periodKey(day, 'week')).toBe('2026-11-02');
    expect(periodKey('2026-11-09', 'week')).toBe('2026-11-09');
  });

  it('crosses month and year boundaries for weeks', () => {
    expect(periodKey('2026-01-01', 'week')).toBe('2025-12-29');
    expect(periodKey('2026-03-01', 'week')).toBe('2026-02-23');
  });
});

describe('periodLabel', () => {
  it('names weeks by their Monday and years by number', () => {
    expect(periodLabel('2026-11-02', 'week')).toMatch(/^Week of /);
    expect(periodLabel('2026', 'year')).toBe('2026');
  });
});
