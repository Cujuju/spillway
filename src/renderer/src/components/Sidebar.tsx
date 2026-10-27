import { Activity as ActivityIcon, ChevronLeft, ChevronRight, Gauge, ScrollText, Settings as SettingsIcon, Users } from 'lucide-solid';
import { For, Show, type JSX } from 'solid-js';
import { page, setPage, settings, snapshot, updateSettings, type Page } from '../store';
import { BuildCard } from './BuildCard';
import { ProxyStateIcon, proxyStatusText } from './ProxyState';

const ICON_PX = 15;
const TOGGLE_ICON_PX = 12;

const NAV: { group: string; items: { id: Page; label: string; icon: () => JSX.Element }[] }[] = [
  {
    group: 'Monitor',
    items: [
      { id: 'dashboard', label: 'Dashboard', icon: () => <Gauge size={ICON_PX} /> },
      { id: 'accounts', label: 'Accounts', icon: () => <Users size={ICON_PX} /> },
      { id: 'activity', label: 'Activity', icon: () => <ActivityIcon size={ICON_PX} /> },
    ],
  },
  {
    group: 'System',
    items: [
      { id: 'proxy', label: 'Proxy', icon: () => <ProxyStateIcon size={ICON_PX} /> },
      { id: 'logs', label: 'Logs', icon: () => <ScrollText size={ICON_PX} /> },
      { id: 'settings', label: 'Settings', icon: () => <SettingsIcon size={ICON_PX} /> },
    ],
  },
];

/** Page navigation. Collapsed, it is an icon rail: labels move to tooltips and badges sit on the icons. */
export function Sidebar() {
  const accountCount = () => snapshot()?.credentials.length ?? 0;
  const collapsed = () => settings().general.sidebarCollapsed;
  const toggle = () => void updateSettings((d) => { d.general.sidebarCollapsed = !d.general.sidebarCollapsed; });
  const tooltip = (item: { id: Page; label: string }) => {
    const status = item.id === 'proxy' ? proxyStatusText() : undefined;
    if (!collapsed()) return status;
    return status ? `${item.label} · ${status}` : item.label;
  };
  return (
    <nav class="sidebar" classList={{ collapsed: collapsed() }}>
      <For each={NAV}>
        {(group) => (
          <>
            <div class="sidebar-group">{collapsed() ? '' : group.group}</div>
            <For each={group.items}>
              {(item) => (
                <button
                  class="nav-btn"
                  classList={{ active: page() === item.id }}
                  title={tooltip(item)}
                  aria-label={item.label}
                  onClick={() => setPage(item.id)}
                >
                  {item.icon()}
                  <Show when={!collapsed()}>
                    <span class="spacer">{item.label}</span>
                  </Show>
                  {/* Collapsed, CSS pins the badge to the icon's corner. */}
                  <Show when={item.id === 'accounts' && accountCount() > 0}>
                    <span class="badge">{accountCount()}</span>
                  </Show>
                </button>
              )}
            </For>
          </>
        )}
      </For>
      <Show when={!collapsed()}>
        <BuildCard />
      </Show>
      <button
        type="button"
        class="sidebar-toggle"
        title={collapsed() ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-label={collapsed() ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-expanded={!collapsed()}
        onClick={toggle}
      >
        {collapsed() ? <ChevronRight size={TOGGLE_ICON_PX} /> : <ChevronLeft size={TOGGLE_ICON_PX} />}
      </button>
    </nav>
  );
}
