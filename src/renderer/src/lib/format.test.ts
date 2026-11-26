import { afterEach, describe, expect, it } from 'vitest';
import { appLocale, setHourCycle } from '@shared/timeFormat';
import { byteSize, compactDuration, compactNumber, dateTime, dayLabel, dayTime, quotaPercent, usd } from './format';

const H = 3_600_000;
afterEach(() => setHourCycle(null));

describe('date labels', () => {
  it.each(['h23', 'h12', null] as const)('matches native date labels with hour cycle %s', (cycle) => {
    setHourCycle(cycle);
    const date = new Date(2026, 0, 1, 15, 5);
    const locale = appLocale();
    const time = { hour: 'numeric', minute: '2-digit' } as const;
    const day = { month: 'short', day: 'numeric' } as const;
    expect(dayTime(date.getTime())).toBe(date.toLocaleString(locale, { weekday: 'short', ...time }));
    expect(dayLabel('2026-01-01')).toBe(date.toLocaleDateString(locale, { weekday: 'short', ...day }));
    const label = date.toLocaleString(locale, { ...day, ...time });
    expect(dateTime(date.getTime())).toBe(label);
    expect(dateTime(date.toISOString())).toBe(label);
  });

  it('preserves invalid date text', () => {
    expect(dateTime('invalid')).toBe('Invalid Date');
    expect(dayTime(NaN)).toBe('Invalid Date');
    expect(dayLabel('invalid')).toBe('Invalid Date');
  });
});

describe('usd', () => {
  it('shows amounts below a cent, exact cents and whole dollars at the existing cutoff', () => {
    expect(usd(0.001)).toBe('<$0.01');
    expect(usd(0.01)).toBe('$0.01');
    expect(usd(0)).toBe('$0.00');
    expect(usd(999.99)).toBe('$999.99');
    expect(usd(1000.4)).toBe('$1,000');
  });

  it('preserves custom precision and native bounds', () => {
    expect(usd(0.00001, 4)).toBe('<$0.0001');
    expect(usd(0.1, 4)).toBe('$0.1000');
    expect(usd(0.5, 0)).toBe('<$1');
    expect(usd(12.34, 1.9)).toBe('$12.3');
    expect(usd(0.05, 1.9)).toBe('$0.1');
    expect(usd(1000, 101)).toBe('$1,000');
    expect(() => usd(1, 100.9)).toThrow(RangeError);
    expect(() => usd(1, NaN)).toThrow(RangeError);
  });
});

it('matches native compact number formatting', () => {
  const value = 1_234_567;
  expect(compactNumber(value)).toBe(value.toLocaleString(appLocale(), { notation: 'compact', maximumFractionDigits: 1 }));
});

describe('compactDuration', () => {
  it('shows two largest units', () => {
    expect(compactDuration(55 * H)).toBe('2d 7h');
    expect(compactDuration(3 * H + 12 * 60_000)).toBe('3h 12m');
    expect(compactDuration(45 * 60_000)).toBe('45m');
    expect(compactDuration(1000)).toBe('now');
  });
});

describe('quotaPercent', () => {
  it('shows three significant digits, truncated', () => {
    expect(quotaPercent(45.37)).toBe('45.3%');
    expect(quotaPercent(7.259)).toBe('7.25%');
    expect(quotaPercent(0.0042)).toBe('0.0042%');
    expect(quotaPercent(99.96)).toBe('99.9%');
    expect(quotaPercent(100)).toBe('100%');
    expect(quotaPercent(0)).toBe('0%');
    expect(quotaPercent(null)).toBe('—');
  });
  it('ignores float noise before truncating', () => {
    expect(quotaPercent(56.99999999999999)).toBe('57%');
    expect(quotaPercent(100 - 42.99999999999999)).toBe('57%');
    expect(quotaPercent(7.000000000000001)).toBe('7%');
  });
});

describe('byteSize', () => {
  it('reads small stores in KiB and larger ones in MiB and matches native formatting', () => {
    expect(byteSize(0)).toBe('0 KiB');
    expect(byteSize(1536)).toBe('1.5 KiB');
    expect(byteSize(100 * 1024 * 1024)).toBe('100 MiB');
    const bytes = 1_572_864;
    expect(byteSize(bytes)).toBe(`${(bytes / (1024 * 1024)).toLocaleString(appLocale(), { maximumFractionDigits: 1 })} MiB`);
  });
});
