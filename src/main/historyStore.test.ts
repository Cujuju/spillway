import { describe, expect, it, vi } from 'vitest';

vi.mock('./paths', () => ({ appPaths: { historyFile: 'unused' } }));
vi.mock('./settingsStore', () => ({ writeFileAtomic: () => undefined }));

const { appendSample } = await import('./historyStore');

const sample = (at: string, used: number, reset?: string) => ({
  at, used: { a: { seven_day: used } }, resets: reset ? { a: { seven_day: Date.parse(reset) } } : undefined,
});
const times = (s: { at: string }[]) => s.map((x) => x.at.slice(11, 16));

describe('appendSample', () => {
  it('replaces the newest point while it is within the spacing of the one before', () => {
    const two = [sample('2026-10-25T00:00:00Z', 10), sample('2026-10-25T00:01:00Z', 11)];
    expect(times(appendSample(two, sample('2026-10-25T00:02:00Z', 12)))).toEqual(['00:00', '00:02']);
  });

  it('appends once the newest point is a spacing past the one before', () => {
    const two = [sample('2026-10-25T00:00:00Z', 10), sample('2026-10-25T00:05:00Z', 11)];
    expect(times(appendSample(two, sample('2026-10-25T00:06:00Z', 12)))).toEqual(['00:00', '00:05', '00:06']);
  });

  it('keeps the last point before a reset', () => {
    const two = [sample('2026-10-25T00:00:00Z', 80, '2026-10-25T00:02:00Z'), sample('2026-10-25T00:01:00Z', 90, '2026-10-25T00:02:00Z')];
    expect(times(appendSample(two, sample('2026-10-25T00:03:00Z', 1)))).toEqual(['00:00', '00:01', '00:03']);
  });

  it('trims past retention', () => {
    const old = sample('2026-10-01T00:00:00Z', 5);
    const recent = sample('2026-10-24T00:00:00Z', 6);
    const out = appendSample([old, recent], sample('2026-10-25T00:00:00Z', 7));
    expect(out.map((s) => s.at)).toEqual(['2026-10-24T00:00:00Z', '2026-10-25T00:00:00Z']);
  });
});
