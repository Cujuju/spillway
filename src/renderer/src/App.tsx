import { createEffect, Match, Switch } from 'solid-js';
import { Sidebar } from './components/Sidebar';
import { TitleBar } from './components/TitleBar';
import { TrayIconSync } from './components/TrayIconSync';
import { Accounts } from './pages/Accounts';
import { Activity } from './pages/Activity';
import { Dashboard } from './pages/Dashboard';
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
          <div class="page-inner">
            <Switch>
              <Match when={page() === 'dashboard'}><Dashboard /></Match>
              <Match when={page() === 'accounts'}><Accounts /></Match>
              <Match when={page() === 'activity'}><Activity /></Match>
              <Match when={page() === 'proxy'}><Proxy /></Match>
              <Match when={page() === 'settings'}><Settings /></Match>
            </Switch>
          </div>
        </main>
      </div>
      <TrayIconSync />
    </div>
  );
}
