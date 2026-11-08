import { createEffect, createMemo, onCleanup, type Accessor } from 'solid-js';

/** Where the shown exchange sits in its list: `index` of `count`, -1 when not listed. */
export interface InspectorStep { index: number; count: number; onStep: (delta: -1 | 1) => void }

/** Keys that step through the list while an exchange is open. */
const STEP_KEYS: Record<string, -1 | 1> = { ArrowUp: -1, ArrowDown: 1 };
/** Keys that open or close a focused row's exchange, like a button. */
const ACTIVATE_KEYS = new Set(['Enter', ' ']);
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
/** A dialog (ui.tsx Dialog, such as a diagnostic bundle) or an open menu owns the keyboard. */
const modalOpen = () => document.querySelector('.dialog-backdrop, :popover-open') !== null;

/**
 * While an exchange is open, ↑/↓ step through `ids` and Esc closes it; keys typed into a field or a modal are left alone.
 * Returns the inspector's step readout.
 */
export function createExchangeSteps(ids: Accessor<readonly string[]>, open: Accessor<string | undefined>, setOpen: (id: string | undefined) => void): Accessor<InspectorStep> {
  const exchanges = createMemo(() => [...new Set(ids())]);
  const position = createMemo(() => exchanges().indexOf(open() ?? ''));
  const onStep = (delta: -1 | 1) => { const id = exchanges()[position() + delta]; if (id) setOpen(id); };
  createEffect(() => {
    if (!open()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || typing(e.target) || modalOpen()) return;
      if (e.key === 'Escape') { setOpen(undefined); return; }
      const delta = STEP_KEYS[e.key];
      if (delta) { e.preventDefault(); onStep(delta); }
    };
    document.addEventListener('keydown', onKey);
    onCleanup(() => document.removeEventListener('keydown', onKey));
  });
  return () => ({ index: position(), count: exchanges().length, onStep });
}

/** A row's keydown that toggles its exchange: Enter or Space on the focused row itself. */
export function onRowActivate(e: KeyboardEvent, toggle: () => void): void {
  if (e.target === e.currentTarget && ACTIVATE_KEYS.has(e.key)) { e.preventDefault(); toggle(); }
}

/** Keeps an opened row in its list's view, so stepping never leaves it hidden. */
export const REVEAL_ROW: ScrollIntoViewOptions = { block: 'nearest' };
