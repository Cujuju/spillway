import { createSignal, type Accessor } from 'solid-js';
import { isSticky, MAX_CONSOLE_LINES, type Notice } from '@shared/notice';

/** Windows' default toast time (5 s) plus a second for the slide-in. */
export const NOTICE_VISIBLE_MS = 6000;
/** Console's largest tail; other styles show fewer. */
const MAX_KEPT = MAX_CONSOLE_LINES;

interface Clock { timer: ReturnType<typeof setTimeout> | null; deadline: number; remaining: number }

export interface NoticeQueue {
  items: Accessor<Notice[]>;
  push(n: Notice): void;
  dismiss(id: number): void;
  clear(): void;
  /** Hover holds every notice on screen; leaving restarts each with the time it had left. */
  pause(): void;
  resume(): void;
}

/** Notices on screen, oldest first. Errors stay until dismissed; the rest expire. */
export function createNoticeQueue(visibleMs = NOTICE_VISIBLE_MS): NoticeQueue {
  const [items, setItems] = createSignal<Notice[]>([]);
  const clocks = new Map<number, Clock>();
  let paused = false;

  const stop = (id: number) => {
    const c = clocks.get(id);
    if (c?.timer) clearTimeout(c.timer);
    clocks.delete(id);
  };
  const run = (id: number, ms: number) => {
    clocks.set(id, { timer: paused ? null : setTimeout(() => dismiss(id), ms), deadline: Date.now() + ms, remaining: ms });
  };
  function dismiss(id: number): void {
    stop(id);
    setItems((xs) => xs.filter((x) => x.id !== id));
  }

  return {
    items,
    push(n) {
      const kept = [...items(), n].slice(-MAX_KEPT);
      for (const x of items()) if (!kept.includes(x)) stop(x.id);
      setItems(kept);
      if (!isSticky(n)) run(n.id, visibleMs);
    },
    dismiss,
    clear() {
      for (const id of [...clocks.keys()]) stop(id);
      setItems([]);
    },
    pause() {
      if (paused) return;
      paused = true;
      const now = Date.now();
      for (const c of clocks.values()) {
        if (c.timer) clearTimeout(c.timer);
        c.timer = null;
        c.remaining = Math.max(0, c.deadline - now);
      }
    },
    resume() {
      if (!paused) return;
      paused = false;
      for (const [id, c] of [...clocks]) run(id, c.remaining);
    },
  };
}
