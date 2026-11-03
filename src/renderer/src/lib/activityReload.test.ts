import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createActivityReload } from './activityReload';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it('refreshes aggregates regularly during steady traffic instead of waiting for silence', () => {
  const load = vi.fn();
  const reload = createActivityReload(load);
  for (let second = 0; second < 10; second++) {
    reload.schedule();
    vi.advanceTimersByTime(1_000);
  }
  expect(load).toHaveBeenCalledTimes(5);
  reload.cancel();
});

it('coalesces a short burst into one reload', () => {
  const load = vi.fn();
  const reload = createActivityReload(load);
  for (let i = 0; i < 5; i++) { reload.schedule(); vi.advanceTimersByTime(100); }
  expect(load).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1_500);
  expect(load).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(10_000);
  expect(load).toHaveBeenCalledOnce();
});

it('cancels pending work on disposal or an immediate reset refresh', () => {
  const load = vi.fn();
  const reload = createActivityReload(load);
  reload.schedule();
  reload.cancel();
  vi.advanceTimersByTime(2_000);
  expect(load).not.toHaveBeenCalled();
  reload.schedule();
  reload.refresh();
  expect(load).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(2_000);
  expect(load).toHaveBeenCalledOnce();
  reload.schedule();
  vi.advanceTimersByTime(2_000);
  expect(load).toHaveBeenCalledTimes(2);
});
