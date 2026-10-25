import { describe, expect, it, vi } from 'vitest';

vi.mock('./paths', () => ({ appPaths: { historyFile: 'unused' } }));
vi.mock('./settingsStore', () => ({ writeFileAtomic: () => undefined }));

const { appendSample } = await import('./historyStore');

const sample = (at: string, used: number) => ({ at, used: { a: { seven_day: used } } });

describe('appendSample', () => {
  it('drops points closer than the spacing', () => {
    const one = [sample('2026-10-25T00:00:00Z', 10)];
    expect(appendSample(one, sample('2026-10-25T00:01:00Z', 11))).toBe(one);
  });

  it('keeps a close point when a window reset', () => {
    const one = [sample('2026-10-25T00:00:00Z', 90)];
    expect(appendSample(one, sample('2026-10-25T00:01:00Z', 0))).toHaveLength(2);
  });

  it('keeps spaced points and trims past retention', () => {
    const old = sample('2026-10-01T00:00:00Z', 5);
    const recent = sample('2026-10-24T00:00:00Z', 6);
    const out = appendSample([old, recent], sample('2026-10-25T00:00:00Z', 7));
    expect(out.map((s) => s.at)).toEqual(['2026-10-24T00:00:00Z', '2026-10-25T00:00:00Z']);
  });
});
