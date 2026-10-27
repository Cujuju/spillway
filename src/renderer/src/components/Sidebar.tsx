import { Activity as ActivityIcon, ChevronLeft, ChevronRight, Gauge, Network, ScrollText, Settings as SettingsIcon } from 'lucide-solid';
import { For, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { page, setPage, settings, snapshot, updateSettings, type Page } from '../store';
import { isMac } from '../lib/platform';
import { BuildCard } from './BuildCard';
import { ProxyStateIcon, proxyStatusText } from './ProxyState';

const ICON_PX = 15;
const TOGGLE_ICON_PX = 12;
/** Same key as VS Code's sidebar toggle. */
const TOGGLE_KEY = 'b';
const TOGGLE_SHORTCUT = isMac ? '⌘B' : 'Ctrl+B';

interface NavItem {
  id: Page;
  label: string;
  icon: () => JSX.Element;
  /** Draws a rule above the item, setting it apart from the views before it. */
  dividerBefore?: boolean;
}

const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'Monitor',
    items: [
      { id: 'dashboard', label: 'Dashboard', icon: () => <Gauge size={ICON_PX} /> },
      { id: 'activity', label: 'Activity', icon: () => <ActivityIcon size={ICON_PX} /> },
      { id: 'providers', label: 'Providers', icon: () => <Network size={ICON_PX} />, dividerBefore: true },
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

/** Page navigation. Collapsed, it is an icon rail: labels move to tooltips and badges sit on the icons. Toggles by button, shortcut, or double-clicking an item. */
export function Sidebar() {
  const accountCount = () => snapshot()?.credentials.length ?? 0;
  const collapsed = () => settings().general.sidebarCollapsed;
  const toggle = () => void updateSettings((d) => { d.general.sidebarCollapsed = !d.general.sidebarCollapsed; });
  const onKey = (e: KeyboardEvent) => {
    const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (!mod || e.shiftKey || e.altKey || e.repeat || e.key.toLowerCase() !== TOGGLE_KEY) return;
    e.preventDefault();
    toggle();
  };
  onMount(() => window.addEventListener('keydown', onKey));
  onCleanup(() => window.removeEventListener('keydown', onKey));
  const toggleLabel = () => `${collapsed() ? 'Expand' : 'Collapse'} sidebar (${TOGGLE_SHORTCUT})`;
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
                <>
                <Show when={item.dividerBefore}>
                  <div class="sidebar-divider" role="separator" />
                </Show>
                <button
                  class="nav-btn"
                  classList={{ active: page() === item.id }}
                  title={tooltip(item)}
                  aria-label={item.label}
                  onClick={() => setPage(item.id)}
                  onDblClick={toggle}
                >
                  {item.icon()}
                  <Show when={!collapsed()}>
                    <span class="spacer">{item.label}</span>
                  </Show>
                  {/* Collapsed, CSS pins the badge to the icon's corner. */}
                  <Show when={item.id === 'providers' && accountCount() > 0}>
                    <span class="badge">{accountCount()}</span>
                  </Show>
                </button>
                </>
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
        title={toggleLabel()}
        aria-label={toggleLabel()}
        aria-expanded={!collapsed()}
        onClick={toggle}
      >
        {collapsed() ? <ChevronRight size={TOGGLE_ICON_PX} /> : <ChevronLeft size={TOGGLE_ICON_PX} />}
      </button>
    </nav>
  );
}
