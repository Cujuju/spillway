import { expect, it } from 'vitest';
import { traceViewQuery } from './traceViewQuery';

it('refreshes live traffic while keeping page and inspector bounds tied to the displayed counts', () => {
  const start = Date.parse('2026-11-05T12:00:00Z');
  const first = traceViewQuery({ source: 'proxy', sort: 'cost' }, undefined, start);
  const refreshed = traceViewQuery({ source: 'proxy', sort: 'cost' }, undefined, start + 60_000);
  expect(Date.parse(refreshed.to!)).toBe(start + 60_000);
  expect(Date.parse(refreshed.from!) - Date.parse(first.from!)).toBe(60_000);
  expect(traceViewQuery({ before: 'cursor', sort: 'cost' }, { from: first.from!, to: first.to! }, start + 60_000)).toMatchObject({ before: 'cursor', from: first.from, to: first.to });
});

it('preserves explicitly selected historical dates on refresh, and a custom start with a live end', () => {
  const historical = { from: '2026-10-30T12:00:00Z', to: '2026-11-01T12:00:00Z' };
  expect(traceViewQuery(historical, undefined, Date.parse('2026-11-05T12:00:00Z'))).toEqual(historical);
  expect(traceViewQuery({ from: historical.from }, undefined, Date.parse('2026-11-05T12:00:00Z'))).toMatchObject({ from: historical.from, to: '2026-11-05T12:00:00.000Z' });
});
