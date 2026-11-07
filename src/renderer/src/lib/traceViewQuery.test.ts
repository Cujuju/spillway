import { expect, it } from 'vitest';
import { traceViewQuery, type TraceWindow } from './traceViewQuery';

const WEEK: TraceWindow = { range: '7d', custom: { from: '2026-10-30', to: '2026-11-01' } };

it('advances a preset on refresh while page and inspector bounds stay tied to the displayed counts', () => {
  const start = new Date(2026, 10, 5, 12).getTime();
  const first = traceViewQuery({ source: 'proxy', sort: 'cost' }, WEEK, undefined, start);
  const refreshed = traceViewQuery({ source: 'proxy', sort: 'cost' }, WEEK, undefined, start + 60_000);
  expect(Date.parse(first.from!)).toBe(new Date(2026, 9, 30).getTime());
  expect(Date.parse(refreshed.to!)).toBe(start + 60_000);
  expect(refreshed.from).toBe(first.from);
  expect(traceViewQuery({ before: 'cursor', sort: 'cost' }, WEEK, { from: first.from!, to: first.to! }, start + 60_000)).toMatchObject({ before: 'cursor', from: first.from, to: first.to });
});

it('spans whole local days for custom dates', () => {
  const q = traceViewQuery({}, { ...WEEK, range: 'custom' }, undefined, new Date(2026, 10, 5, 12).getTime());
  expect(Date.parse(q.from!)).toBe(new Date(2026, 9, 30).getTime());
  expect(Date.parse(q.to!)).toBe(new Date(2026, 10, 2).getTime() - 1);
});
