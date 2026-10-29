import { describe, expect, it } from 'vitest';
import { MIN_ZOOM_SPAN_MS, panRange, timeTicks, wheelFactor, zoomRange } from './chartZoom';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const bounds = { from: 0, to: 10 * DAY };
const view = { from: 4 * DAY, to: 6 * DAY };

describe('wheelFactor', () => {
  it('widens on wheel up and narrows on wheel down, symmetrically', () => {
    expect(wheelFactor(-100)).toBeGreaterThan(1);
    expect(wheelFactor(100)).toBeLessThan(1);
    expect(wheelFactor(-100) * wheelFactor(100)).toBeCloseTo(1);
  });
});

describe('zoomRange', () => {
  it('keeps the anchor at the same place on screen', () => {
    const anchor = 4.5 * DAY;
    const next = zoomRange(view, anchor, 2, bounds);
    expect(next.to - next.from).toBe(4 * DAY);
    expect((anchor - next.from) / (next.to - next.from)).toBeCloseTo((anchor - view.from) / (view.to - view.from));
  });

  it('never widens past the bounds, shifting to fit', () => {
    expect(zoomRange(view, 9 * DAY, 100, bounds)).toEqual(bounds);
    const next = zoomRange({ from: 8 * DAY, to: 10 * DAY }, 10 * DAY, 2, bounds);
    expect(next).toEqual({ from: 6 * DAY, to: 10 * DAY });
  });

  it('never narrows below the minimum span', () => {
    const next = zoomRange(view, 5 * DAY, 1e-9, bounds);
    expect(next.to - next.from).toBe(MIN_ZOOM_SPAN_MS);
  });

  it('takes bounds narrower than the minimum span as the whole view', () => {
    const tight = { from: 0, to: MIN_ZOOM_SPAN_MS / 2 };
    expect(zoomRange(tight, 0, 0.5, tight)).toEqual(tight);
  });
});

describe('panRange', () => {
  it('moves the view by the shift, keeping its span', () => {
    expect(panRange(view, -DAY, bounds)).toEqual({ from: 3 * DAY, to: 5 * DAY });
    expect(panRange(view, DAY, bounds)).toEqual({ from: 5 * DAY, to: 7 * DAY });
  });

  it('stops at either edge of the bounds', () => {
    expect(panRange(view, -100 * DAY, bounds)).toEqual({ from: 0, to: 2 * DAY });
    expect(panRange(view, 100 * DAY, bounds)).toEqual({ from: 8 * DAY, to: 10 * DAY });
  });
});

describe('timeTicks', () => {
  const start = new Date(2026, 9, 20, 0, 7).getTime();
  const count = (span: number) => timeTicks({ from: start, to: start + span }).length;

  it('stays readable at every zoom level', () => {
    for (const span of [MIN_ZOOM_SPAN_MS, 6 * HOUR, DAY, 3 * DAY, 8 * DAY, 28 * DAY]) {
      expect(count(span)).toBeGreaterThan(0);
      expect(count(span)).toBeLessThanOrEqual(12);
    }
  });

  it('places every tick inside the range', () => {
    const range = { from: start, to: start + 2 * DAY };
    for (const tick of timeTicks(range)) expect(tick.t).toBeGreaterThanOrEqual(range.from);
  });
});
