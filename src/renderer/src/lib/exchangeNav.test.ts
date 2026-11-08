import { createRoot, createSignal, untrack } from 'solid-js';
import { expect, it } from 'vitest';
import { createExchangeSteps } from './exchangeNav';

it('steps through unique exchanges in first-occurrence order as the list changes', () => createRoot((dispose) => {
  const [ids, setIds] = createSignal(['A', 'A', 'B']);
  const [open, setOpen] = createSignal<string | undefined>('A');
  const steps = createExchangeSteps(ids, open, setOpen);
  try {
    expect(steps()).toMatchObject({ index: 0, count: 2 });
    steps().onStep(1);
    expect(untrack(open)).toBe('B');
    expect(steps()).toMatchObject({ index: 1, count: 2 });
    steps().onStep(-1);
    expect(untrack(open)).toBe('A');
    setIds(['B', 'B', 'A', 'C']);
    expect(steps()).toMatchObject({ index: 1, count: 3 });
    steps().onStep(1);
    expect(untrack(open)).toBe('C');
  } finally { dispose(); }
}));
