import { createEffect, Match, Switch } from 'solid-js';
import { Sidebar } from './components/Sidebar';
import { TitleBar } from './components/TitleBar';
import { TrayIconSync } from './components/TrayIconSync';
import { Accounts } from './pages/Accounts';
import { Activity } from './pages/Activity';
import { Dashboard } from './pages/Dashboard';
import { Logs } from './pages/Logs';
import { Providers } from './pages/Providers';
import { Proxy } from './pages/Proxy';
import { Settings } from './pages/Settings';
import { applyTheme, page, settings } from './store';

export function App() {
  createEffect(() => applyTheme(settings().general.theme));
  return (
    <div class="shell">
      <TitleBar />
      <div class="shell-body">
        <Sidebar />
        <main class="page">
          {/* These pages give their spare height to one child (log view, board, quota chart) instead of leaving it blank. */}
          <div class="page-inner" classList={{ fill: page() === 'logs' || page() === 'activity' || page() === 'dashboard' }}>
            <Switch>
              <Match when={page() === 'dashboard'}><Dashboard /></Match>
              <Match when={page() === 'accounts'}><Accounts /></Match>
              <Match when={page() === 'providers'}><Providers /></Match>
              <Match when={page() === 'activity'}><Activity /></Match>
              <Match when={page() === 'proxy'}><Proxy /></Match>
              <Match when={page() === 'logs'}><Logs /></Match>
              <Match when={page() === 'settings'}><Settings /></Match>
            </Switch>
          </div>
        </main>
      </div>
      <TrayIconSync />
    </div>
  );
}
