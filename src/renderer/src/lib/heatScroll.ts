import { createEffect, createMemo, onCleanup } from 'solid-js';
import { heatShape } from './activityHeat';
import type { Span } from './activityRange';

/** Open a changed range at its newest column. */
export function createHeatScroll(span: () => Span, scroller: () => Pick<HTMLElement, 'scrollLeft' | 'scrollWidth'>) {
  const range = createMemo(() => `${span().from}:${heatShape(span())}`);
  createEffect(() => {
    void range();
    const frame = requestAnimationFrame(() => { scroller().scrollLeft = scroller().scrollWidth; });
    onCleanup(() => cancelAnimationFrame(frame));
  });
}
