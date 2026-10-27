import { Plus, RefreshCw, Search } from 'lucide-solid';
import { createMemo, createSignal, For, Match, Show, Switch } from 'solid-js';
import type { Credential } from '@shared/types';
import { providerLabel } from '@shared/trayValues';
import { AccountRow } from '../components/AccountRow';
import { PoolPanel } from '../components/PoolPanel';
import { createProviderPools } from '../components/poolModel';
import { ALL_PROVIDERS as ALL, ProviderCards } from '../components/ProviderCards';
import { ShowEmailsButton } from '../components/ShowEmailsButton';
import { Notice } from '../components/ui';
import { poolWindowKey } from '../lib/forecast';
import { durationChoices, lengthLineId } from '../lib/poolWindows';
import { proxyStatus, setPage, settings, snapshot, updateSettings, usageError } from '../store';

const ICON_PX = 14;
/** Claude first: it is the provider this app was built around; the rest by account count. */
const PRIMARY_PROVIDER = 'claude';

const used = (c: Credential, key: string | null) => c.windows.find((w) => w.key === key)?.usedPercent ?? null;
const resetAt = (c: Credential, key: string | null) => {
  const r = c.windows.find((w) => w.key === key)?.resetsAt;
  return r ? Date.parse(r) : Infinity;
};

export function Dashboard() {
  const [chosen, setChosen] = createSignal<string | null>(null);
  const [chosenLine, setChosenLine] = createSignal<string | null>(null);
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

  // Window lengths across providers (5-hour, weekly). The chart shows one card line; the longest length by default.
  const lengths = createMemo(() => durationChoices(providers().map((p) => credsOf(p.id))));
  const cards = createProviderPools(() => providers().map((p) => p.id), credsOf, lengths, () => snapshot()?.strategy ?? '');
  const lineId = () => {
    const c = chosenLine();
    if (c && cards().some((p) => p.lines().some((l) => l.id === c))) return c;
    const longest = lengths().at(-1)?.value;
    return longest ? lengthLineId(longest) : null;
  };
  const chartModels = () =>
    cards()
      .filter((c) => provider() === ALL || c.id === provider())
      .flatMap((c) => c.lines().filter((l) => l.id === lineId()).map((l) => l.model));
  // Each provider sorts by its own widest window; keys differ between providers.
  const sortKeys = createMemo(() => new Map(providers().map((p) => [p.id, poolWindowKey(credsOf(p.id))])));
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
          <ShowEmailsButton class="btn page-action" />
          <button class="btn page-action solid" disabled={refreshing() || proxyState() !== 'running'} onClick={refreshAll}>
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
            <button class="btn primary" onClick={() => setPage('providers')}>
              <Plus size={ICON_PX} /> Add account
            </button>
          </div>
        }
      >
        <ProviderCards
          pools={cards()}
          showAll={multi()}
          total={creds().length}
          selected={provider()}
          chosenLine={lineId()}
          onSelect={setChosen}
          onLine={setChosenLine}
        />
        <PoolPanel models={chartModels()} />

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
        {/* Slots: the most limit bars any row shows, so the bars block is as wide as the fullest row. */}
        <div class="account-list" style={{ '--limit-slots': Math.max(1, ...rows().map((c) => c.windows.length)) }}>
          <For each={rows()} fallback={<div class="empty-state">No accounts match “{query()}”.</div>}>
            {(c) => <AccountRow credential={c} />}
          </For>
        </div>
      </Show>
    </>
  );
}
