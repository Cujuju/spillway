import { Gauge, Server, Settings as SettingsIcon, Users } from 'lucide-solid';
import { For, type JSX } from 'solid-js';
import { page, setPage, snapshot, type Page } from '../store';
import { ProxyStateDot, proxyStatusText } from './ProxyState';

const ICON_PX = 15;

const NAV: { group: string; items: { id: Page; label: string; icon: () => JSX.Element }[] }[] = [
  {
    group: 'Monitor',
    items: [
      { id: 'dashboard', label: 'Dashboard', icon: () => <Gauge size={ICON_PX} /> },
      { id: 'accounts', label: 'Accounts', icon: () => <Users size={ICON_PX} /> },
    ],
  },
  {
    group: 'System',
    items: [
      { id: 'proxy', label: 'Proxy', icon: () => <Server size={ICON_PX} /> },
      { id: 'settings', label: 'Settings', icon: () => <SettingsIcon size={ICON_PX} /> },
    ],
  },
];

export function Sidebar() {
  const accountCount = () => snapshot()?.credentials.length ?? 0;
  return (
    <nav class="sidebar">
      <For each={NAV}>
        {(group) => (
          <>
            <div class="sidebar-group">{group.group}</div>
            <For each={group.items}>
              {(item) => (
                <button
                  class="nav-btn"
                  classList={{ active: page() === item.id }}
                  title={item.id === 'proxy' ? proxyStatusText() : undefined}
                  onClick={() => setPage(item.id)}
                >
                  {item.icon()}
                  <span class="spacer">{item.label}</span>
                  {item.id === 'accounts' && accountCount() > 0 ? <span class="badge">{accountCount()}</span> : null}
                  {item.id === 'proxy' ? <ProxyStateDot /> : null}
                </button>
              )}
            </For>
          </>
        )}
      </For>
    </nav>
  );
}
