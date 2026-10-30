import { createRoot, createSignal } from 'solid-js';
import { afterEach, expect, it, vi } from 'vitest';
import { createHeatScroll } from './heatScroll';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('keeps manual scroll on a minute tick and follows a changed range', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  const scroller = { scrollLeft: 0, scrollWidth: 1000 };
  const [span, setSpan] = createSignal({ from: new Date(2026, 9, 20).getTime(), to: new Date(2026, 9, 26, 12).getTime() });
  const dispose = createRoot((dispose) => { createHeatScroll(span, () => scroller); return dispose; });
  try {
    await vi.runAllTimersAsync();
    expect(scroller.scrollLeft).toBe(1000);
    scroller.scrollLeft = 120;
    setSpan((s) => ({ ...s, to: s.to + 60_000 }));
    await vi.runAllTimersAsync();
    expect(scroller.scrollLeft).toBe(120);
    setSpan((s) => ({ ...s, from: s.from - 86_400_000 }));
    await vi.runAllTimersAsync();
    expect(scroller.scrollLeft).toBe(1000);
    scroller.scrollLeft = 120;
    setSpan((s) => ({ ...s, to: s.to + 30 * 86_400_000 }));
    await vi.runAllTimersAsync();
    expect(scroller.scrollLeft).toBe(1000);
  } finally { dispose(); }
});
