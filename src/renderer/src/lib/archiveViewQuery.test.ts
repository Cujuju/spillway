import { expect, it } from 'vitest';
import { archiveFiltersNarrowed, archiveViewQuery, RESET_ARCHIVE_FILTERS } from './archiveViewQuery';
import type { TraceWindow } from './traceViewQuery';

const CUSTOM = { from: '2026-10-30', to: '2026-11-01' };
const NOW = new Date(2026, 10, 5, 12).getTime();

it('leaves all time unbounded and keeps the filters', () => {
  expect(archiveViewQuery({ model: 'gpt-5', state: 'complete' }, { range: 'all', custom: CUSTOM }, NOW)).toEqual({ model: 'gpt-5', state: 'complete' });
});

it('opens presets at their first local day with no end, so new records still match', () => {
  const q = archiveViewQuery({}, { range: '7d', custom: CUSTOM }, NOW);
  expect(Date.parse(q.from!)).toBe(new Date(2026, 9, 30).getTime());
  expect(q.to).toBeUndefined();
});

it('ends custom dates with their last local day', () => {
  const window: TraceWindow = { range: 'custom', custom: CUSTOM };
  const q = archiveViewQuery({}, window, NOW);
  expect(Date.parse(q.from!)).toBe(new Date(2026, 9, 30).getTime());
  expect(Date.parse(q.to!)).toBe(new Date(2026, 10, 2).getTime() - 1);
});

it('resets every filter key', () => {
  const all = { text: 'a', sessionId: 'b', provider: 'c', model: 'd', client: 'e', state: 'partial' as const };
  expect(archiveFiltersNarrowed(all)).toBe(true);
  expect(archiveFiltersNarrowed({ ...all, ...RESET_ARCHIVE_FILTERS })).toBe(false);
});
