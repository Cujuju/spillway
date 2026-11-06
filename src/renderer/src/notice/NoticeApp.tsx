import { createEffect, createMemo, createSignal, Match, onCleanup, onMount, Show, Switch } from 'solid-js';
import { deliversTo, type Notice } from '@shared/notice';
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/settings';
import { resolveTheme } from '@shared/themes';
import { paintTheme } from '../lib/theme';
import { ConsoleTail } from './ConsoleTail';
import { createNoticeQueue } from './queue';
import { TopDrip } from './TopDrip';
import { TrayDrip } from './TrayDrip';

/** Painted surfaces that take clicks. */
const INTERACTIVE = '.tray-card, .tray-more, .console, .drip';

/** The notification overlay window: renders the chosen style and tells main its size (zero hides it). */
export function NoticeApp() {
  const [settings, setSettings] = createSignal<AppSettings>(DEFAULT_SETTINGS);
  const [latest, setLatest] = createSignal<Notice | null>(null);
  const queue = createNoticeQueue();
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
  const [dark, setDark] = createSignal(prefersDark.matches);
  const onScheme = () => setDark(prefersDark.matches);
  prefersDark.addEventListener('change', onScheme);

  const offNotice = window.api.onNotice((n) => {
    queue.push(n);
    setLatest(n);
  });
  const offSettings = window.api.onSettings(setSettings);
  void window.api.getSettings().then(setSettings);
  onCleanup(() => {
    offNotice();
    offSettings();
    prefersDark.removeEventListener('change', onScheme);
  });

  const theme = createMemo(() => resolveTheme(settings().general.theme, dark()));
  const n = () => settings().notifications;
  const open = (x: Notice) => {
    void window.api.noticeOpen(x.target);
    queue.dismiss(x.id);
  };

  // Only painted notices take the mouse; the window's transparent rest passes clicks through.
  let over = false;
  const track = (target: EventTarget | null) => {
    const now = target instanceof Element && target.closest(INTERACTIVE) !== null;
    if (now !== over) void window.api.noticePointer((over = now));
  };
  const onMove = (e: MouseEvent) => track(e.target);
  const onLeave = () => track(null);
  document.addEventListener('mousemove', onMove);
  document.documentElement.addEventListener('mouseleave', onLeave);
  onCleanup(() => {
    document.removeEventListener('mousemove', onMove);
    document.documentElement.removeEventListener('mouseleave', onLeave);
  });

  let root!: HTMLDivElement;
  let reported = { width: -1, height: -1 };
  const report = () => {
    const r = root.getBoundingClientRect();
    const size = { width: Math.ceil(r.width), height: Math.ceil(r.height) };
    if (size.width === reported.width && size.height === reported.height) return;
    reported = size;
    void window.api.noticeResize(size.width, size.height);
  };
  onMount(() => {
    // A hidden window never paints, so ResizeObserver stays silent; DOM changes still report, so the next notice shows it.
    const mutations = new MutationObserver(report);
    mutations.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    // Size changes from CSS alone (hover), while visible.
    const resizes = new ResizeObserver(report);
    resizes.observe(root);
    report();
    onCleanup(() => {
      mutations.disconnect();
      resizes.disconnect();
    });
  });
  createEffect(() => paintTheme(document.documentElement, theme()));

  return (
    <div ref={root} class="notice-root" onMouseEnter={() => queue.pause()} onMouseLeave={() => queue.resume()}>
      <Show when={deliversTo(n().delivery).overlay}>
        <Switch>
          <Match when={n().style === 'tray'}>
            <TrayDrip items={queue.items()} onOpen={open} onDismiss={queue.dismiss} onClear={queue.clear} />
          </Match>
          <Match when={n().style === 'console'}>
            <ConsoleTail items={queue.items()} lines={n().consoleLines} onOpen={open} onDismiss={queue.dismiss} onClear={queue.clear} />
          </Match>
          <Match when={n().style === 'drip'}>
            <TopDrip latest={latest()} lip={n().dripLip} theme={theme()} onOpen={open} />
          </Match>
        </Switch>
      </Show>
    </div>
  );
}
