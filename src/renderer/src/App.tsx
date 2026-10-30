import { createComputed, createEffect, Match, on, onCleanup, Show, Switch } from 'solid-js';
import { persistedSignal } from './lib/persisted';
import { Sidebar } from './components/Sidebar';
import { TitleBar } from './components/TitleBar';
import { TrayIconSync } from './components/TrayIconSync';
import { Notice } from './components/ui';
import { Activity } from './pages/Activity';
import { Dashboard } from './pages/Dashboard';
import { Help } from './pages/Help';
import { Logs } from './pages/Logs';
import { Providers } from './pages/Providers';
import { Proxy } from './pages/Proxy';
import { Settings } from './pages/Settings';
import { activityImport, applyTheme, page, setSettingsError, settings, settingsError, type Page } from './store';

/** Scroll saves wait for the scrolling to settle, so a fling writes storage once. */
const SCROLL_SAVE_DEBOUNCE_MS = 250;
type ScrollMap = Partial<Record<Page, number>>;
const isScrollMap = (v: unknown): v is ScrollMap =>
  typeof v === 'object' && v !== null && Object.values(v).every((n) => typeof n === 'number' && Number.isFinite(n));

export function App() {
  createEffect(() => applyTheme(settings().general.theme));
  // Each page keeps its own scroll position across page switches and restarts.
  const [scrolls, setScrolls] = persistedSignal<ScrollMap>('pageScroll', {}, isScrollMap);
  let main!: HTMLElement;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingSave: (() => void) | undefined;
  const flushSave = () => {
    clearTimeout(saveTimer);
    pendingSave?.();
    pendingSave = undefined;
  };
  // Swapping pages clamps scrollTop and fires scroll events; ignore them until the restore lands.
  let restoring = false;
  createComputed(on(page, (p) => {
    flushSave();
    restoring = true;
    requestAnimationFrame(() => {
      main.scrollTop = scrolls()[p] ?? 0;
      restoring = false;
    });
  }));
  const onScroll = () => {
    if (restoring) return;
    clearTimeout(saveTimer);
    const p = page();
    const top = main.scrollTop;
    pendingSave = () => setScrolls({ ...scrolls(), [p]: top });
    saveTimer = setTimeout(flushSave, SCROLL_SAVE_DEBOUNCE_MS);
  };
  window.addEventListener('beforeunload', flushSave);
  onCleanup(() => {
    window.removeEventListener('beforeunload', flushSave);
    flushSave();
  });
  return (
    <div class="shell">
      <TitleBar />
      <div class="shell-body">
        <Sidebar />
        <main class="page" ref={main} onScroll={onScroll}>
          {/* These pages give their spare height to one child (log view, board, quota chart) instead of leaving it blank. */}
          <div class="page-inner" classList={{ fill: page() === 'logs' || page() === 'activity' || page() === 'dashboard' }}>
            <Show when={activityImport().error}><Notice>{activityImport().error}</Notice></Show>
            <Show when={settingsError()}>
              {(message) => (
                <Notice tone="error" class="save-error">
                  <span class="spacer">Settings weren't saved: {message()}</span>
                  <button type="button" class="btn" onClick={() => setSettingsError(null)}>Dismiss</button>
                </Notice>
              )}
            </Show>
            <Switch>
              <Match when={page() === 'dashboard'}><Dashboard /></Match>
              <Match when={page() === 'providers'}><Providers /></Match>
              <Match when={page() === 'activity'}><Activity /></Match>
              <Match when={page() === 'proxy'}><Proxy /></Match>
              <Match when={page() === 'logs'}><Logs /></Match>
              <Match when={page() === 'settings'}><Settings /></Match>
              <Match when={page() === 'help'}><Help /></Match>
            </Switch>
          </div>
        </main>
      </div>
      <TrayIconSync />
    </div>
  );
}
