import { Layers, Plus, RefreshCw, Search } from 'lucide-solid';
import { createMemo, createSignal, For, Match, Show, Switch } from 'solid-js';
import type { Credential } from '@shared/types';
import { providerLabel } from '@shared/trayValues';
import { AccountRow } from '../components/AccountRow';
import { PoolPanel } from '../components/PoolPanel';
import { ShowEmailsButton } from '../components/ShowEmailsButton';
import { Notice, ProviderGlyph } from '../components/ui';
import { poolWindowKey } from '../lib/forecast';
import { proxyStatus, setPage, settings, snapshot, updateSettings, usageError } from '../store';

const ICON_PX = 14;
/** Claude first: it is the provider this app was built around; the rest by account count. */
const PRIMARY_PROVIDER = 'claude';
/** Tab id for every provider on one chart. */
const ALL = 'all';

const used = (c: Credential, key: string | null) => c.windows.find((w) => w.key === key)?.usedPercent ?? null;
const resetAt = (c: Credential, key: string | null) => {
  const r = c.windows.find((w) => w.key === key)?.resetsAt;
  return r ? Date.parse(r) : Infinity;
};

export function Dashboard() {
  const [chosen, setChosen] = createSignal<string | null>(null);
  const [query, setQuery] = createSignal('');
  const [refreshing, setRefreshing] = createSignal(false);

  const creds = () => snapshot()?.credentials ?? [];
  const providers = createMemo(() => {
    const counts = new Map<string, number>();
    for (const c of creds()) counts.set(c.provider, (counts.get(c.provider) ?? 0) + 1);
    return [...counts]
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => Number(b.id === PRIMARY_PROVIDER) - Number(a.id === PRIMARY_PROVIDER) || b.count - a.count);
  });
  const multi = () => providers().length > 1;
  // Several providers open on All, so every pool's quota and drain show at once.
  const provider = () => {
    const p = chosen();
    if (p && (providers().some((x) => x.id === p) || (p === ALL && multi()))) return p;
    return multi() ? ALL : (providers()[0]?.id ?? null);
  };
  const credsOf = (id: string) => creds().filter((c) => c.provider === id);
  const providerCreds = createMemo(() => (provider() === ALL ? creds() : credsOf(provider() ?? '')));
  const pools = createMemo(() => (provider() === ALL ? providers().map((p) => p.id) : [provider()!]).map((id) => ({ provider: id, credentials: credsOf(id) })));
  // Each provider sorts by its own widest window; keys differ between providers.
  const sortKeys = createMemo(() => new Map(pools().map((p) => [p.provider, poolWindowKey(p.credentials)])));
  const loaded = () => creds().filter((c) => c.windows.some((w) => w.usedPercent !== null)).length;

  const rows = createMemo(() => {
    const q = query().trim().toLowerCase();
    const keyOf = (c: Credential) => sortKeys().get(c.provider) ?? null;
    const list = providerCreds().filter((c) => !q || [c.label, c.email ?? '', c.name, c.note ?? ''].some((s) => s.toLowerCase().includes(q)));
    const sort = settings().dashboard.accountSort;
    return [...list].sort((a, b) => {
      if (a.disabled !== b.disabled) return Number(a.disabled) - Number(b.disabled);
      if (sort === 'name') return a.label.localeCompare(b.label);
      if (sort === 'usage') return (used(a, keyOf(a)) ?? Infinity) - (used(b, keyOf(b)) ?? Infinity);
      return resetAt(a, keyOf(a)) - resetAt(b, keyOf(b));
    });
  });

  const refreshAll = async () => {
    setRefreshing(true);
    try {
      await window.api.usageRefresh();
    } finally {
      setRefreshing(false);
    }
  };
  const proxyState = () => proxyStatus()?.state ?? 'stopped';

  return (
    <>
      <header class="dash-header">
        <div>
          <h1 class="dash-title">Quota Management</h1>
          <div class="dash-sub">
            {creds().length} credentials · <span class="loaded">{loaded()} loaded</span>
          </div>
        </div>
        <div class="dash-actions">
          <ShowEmailsButton class="btn pill" />
          <button class="btn pill solid" disabled={refreshing() || proxyState() !== 'running'} onClick={refreshAll}>
            <RefreshCw size={ICON_PX} class={refreshing() ? 'spin' : undefined} /> Refresh all credentials
          </button>
        </div>
      </header>

      <Switch>
        <Match when={proxyState() === 'missing-binary'}>
          <Notice tone="error">
            The proxy executable was not found. Set its path on the Proxy page.
            <button class="btn" onClick={() => setPage('proxy')}>Open Proxy</button>
          </Notice>
        </Match>
        <Match when={proxyState() !== 'running'}>
          <Notice>
            <span class="spacer">The proxy is {proxyState()}. Usage updates resume when it runs.</span>
            <button class="btn" disabled={proxyState() === 'starting'} onClick={() => void window.api.proxyStart()}>Start proxy</button>
          </Notice>
        </Match>
        <Match when={usageError()}>
          <Notice tone="error">Usage lookup failed: {usageError()}</Notice>
        </Match>
      </Switch>

      <Show
        when={creds().length > 0}
        fallback={
          <div class="empty-state">
            <h3>No accounts yet</h3>
            <p>Sign in to a Claude, Codex or other subscription account and the proxy will rotate between them.</p>
            <button class="btn primary" onClick={() => setPage('accounts')}>
              <Plus size={ICON_PX} /> Add account
            </button>
          </div>
        }
      >
        <nav class="provider-tabs">
          <Show when={multi()}>
            <button class="provider-tab" classList={{ active: provider() === ALL }} onClick={() => setChosen(ALL)}>
              <Layers size={ICON_PX} />
              All
              <span class="count">{creds().length}</span>
            </button>
          </Show>
          <For each={providers()}>
            {(p) => (
              <button class="provider-tab" classList={{ active: provider() === p.id }} onClick={() => setChosen(p.id)}>
                <ProviderGlyph provider={p.id} />
                {providerLabel(p.id)}
                <span class="count">{p.count}</span>
              </button>
            )}
          </For>
        </nav>

        {/* Keyed: a tab change starts the panel fresh, since window choices differ per tab. */}
        <Show when={provider()} keyed>
          {(_tab) => <PoolPanel pools={pools()} strategy={snapshot()?.strategy ?? ''} />}
        </Show>

        <div class="toolbar">
          <label class="search">
            <Search size={ICON_PX} />
            <input placeholder="Search by name or email" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
          </label>
          <select
            class="select"
            value={settings().dashboard.accountSort}
            onChange={(e) => void updateSettings((d) => { d.dashboard.accountSort = e.currentTarget.value as typeof d.dashboard.accountSort; })}
          >
            <option value="reset">Soonest reset</option>
            <option value="usage">Most left</option>
            <option value="name">Name</option>
          </select>
        </div>
        <For each={rows()} fallback={<div class="empty-state">No accounts match “{query()}”.</div>}>
          {(c) => <AccountRow credential={c} />}
        </For>
      </Show>
    </>
  );
}
