import { expect, it } from 'vitest';
import { CrashWindow, type CrashWindowConfig } from './crashWindow';

const config: CrashWindowConfig = { maxAttempts: 3, windowMs: 1_000, backoffBaseMs: 100 };

it('doubles backoff through the allowed attempts and gives up on the next failure', () => {
  const budget = new CrashWindow(config);
  expect(budget.record(0)).toEqual({ action: 'retry', delayMs: 100 });
  expect(budget.record(1)).toEqual({ action: 'retry', delayMs: 200 });
  expect(budget.record(2)).toEqual({ action: 'retry', delayMs: 400 });
  expect(budget.record(3)).toEqual({ action: 'give-up', count: 4 });
});

it('expires failures at the sliding window boundary', () => {
  const budget = new CrashWindow(config);
  budget.record(0);
  budget.record(1);
  expect(budget.record(config.windowMs)).toEqual({ action: 'retry', delayMs: 200 });
  expect(budget.record(2 * config.windowMs)).toEqual({ action: 'retry', delayMs: 100 });
});

it('clears all failures on reset', () => {
  const budget = new CrashWindow(config);
  budget.record(0);
  budget.record(1);
  budget.reset();
  expect(budget.record(2)).toEqual({ action: 'retry', delayMs: 100 });
});
