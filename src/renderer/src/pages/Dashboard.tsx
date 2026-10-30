import { Plus, RefreshCw, Search } from 'lucide-solid';
import { createMemo, createSignal, For, Match, Show, Switch } from 'solid-js';
import type { Credential } from '@shared/types';
import { providerLabel } from '@shared/trayValues';
import { AccountPanel } from '../components/AccountPanel';
import { AccountRow } from '../components/AccountRow';
import { PoolPanel } from '../components/PoolPanel';
import { createProviderPools } from '../components/poolModel';
import { ALL_PROVIDERS as ALL, ProviderCards } from '../components/ProviderCards';
import { ShowEmailsButton } from '../components/ShowEmailsButton';
import { Notice } from '../components/ui';
import { poolWindowKey } from '../lib/forecast';
import { isString, isStringOrNull, persistedSignal } from '../lib/persisted';
import { durationChoices, lengthLineId } from '../lib/poolWindows';
import { proxyStatus, setPage, settings, snapshot, updateSettings, usageError } from '../store';

const ICON_PX = 14;
/** Claude first: it is the provider this app was built around; the rest by account count. */
const PRIMARY_PROVIDER = 'claude';

const used = (c: Credential, key: string | null) => c.windows.find((w) => w.key === key)?.usedPercent ?? null;
/** Accounts with an account-wide limit reading have a quota history to chart. */
const hasQuota = (c: Credential) => !c.apiKey && c.windows.some((w) => !w.scoped && w.usedPercent !== null);
const resetAt = (c: Credential, key: string | null) => {
  const r = c.windows.find((w) => w.key === key)?.resetsAt;
  return r ? Date.parse(r) : Infinity;
};

export function Dashboard() {
  // A stored pick that no longer exists falls back below (provider(), lineId()).
  const [chosen, setChosen] = persistedSignal<string | null>('dashboard.provider', null, isStringOrNull);
  const [chosenLine, setChosenLine] = persistedSignal<string | null>('dashboard.line', null, isStringOrNull);
  const [query, setQuery] = persistedSignal('dashboard.query', '', isString);
  // Picking an account swaps the pool chart for that account's; a gone account falls back to the pool.
  const [chosenAccount, setChosenAccount] = persistedSignal<string | null>('dashboard.account', null, isStringOrNull);
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
  const focused = () => creds().find((c) => c.id === chosenAccount() && hasQuota(c)) ?? null;
  const toggleAccount = (id: string) => setChosenAccount(focused()?.id === id ? null : id);
  const pickProvider = (p: string) => {
    setChosen(p);
    setChosenAccount(null);
  };
  const pickLine = (id: string) => {
    setChosenLine(id);
    setChosenAccount(null);
  };
  const providerCreds = createMemo(() => (provider() === ALL ? creds() : credsOf(provider() ?? '')));

  // Window lengths across providers (5-hour, weekly). The chart shows one card line; the longest length by default.
  const lengths = createMemo(() => durationChoices(providers().map((p) => credsOf(p.id))));
  const cards = createProviderPools(() => providers().map((p) => p.id), credsOf, lengths, () => snapshot()?.strategy ?? '');
  // Lines of the providers in view; the chart only picks among these, so it never charts an empty window.
  const visibleLines = createMemo(() =>
    cards()
      .filter((c) => provider() === ALL || c.id === provider())
      .flatMap((c) => c.lines().map((line) => ({ provider: c.id, line }))),
  );
  const visibleLengths = () => lengths().filter((l) => visibleLines().some((v) => v.line.id === lengthLineId(l.value)));
  const lineId = () => {
    const c = chosenLine();
    if (c && visibleLines().some((v) => v.line.id === c)) return c;
    const longest = visibleLengths().at(-1)?.value;
    return longest ? lengthLineId(longest) : null;
  };
  const chartModels = () => visibleLines().filter((v) => v.line.id === lineId()).map((v) => v.line.model);
  // Chart window picker: each length in view, plus a charted scoped line; the title names the providers it charts.
  const chartWindows = createMemo(() => {
    const charted = (id: string) => `Charts ${visibleLines().filter((v) => v.line.id === id).map((v) => providerLabel(v.provider)).join(', ')}`;
    const options = visibleLengths().map((l) => ({ value: lengthLineId(l.value), label: l.label, title: charted(lengthLineId(l.value)) }));
    const scoped = visibleLines().find((v) => v.line.scoped && v.line.id === lineId());
    if (scoped) options.push({ value: scoped.line.id, label: scoped.line.label(), title: charted(scoped.line.id) });
    return options;
  });
  // Each provider sorts by its own widest window; keys differ between providers.
  const sortKeys = createMemo(() => new Map(providers().map((p) => [p.id, poolWindowKey(credsOf(p.id))])));
  const loaded = () => creds().filter((c) => c.windows.some((w) => w.usedPercent !== null)).length;

  const rows = createMemo(() => {
    const q = query().trim().toLowerCase();
    const sort = settings().dashboard.accountSort;
    const list = providerCreds()
      .filter((c) => !q || [c.label, c.email ?? '', c.name, c.note ?? ''].some((s) => s.toLowerCase().includes(q)))
      .map((c) => {
        const key = sortKeys().get(c.provider) ?? null;
        return { c, used: used(c, key) ?? Infinity, resetAt: resetAt(c, key) };
      });
    list.sort((a, b) => {
      if (a.c.disabled !== b.c.disabled) return Number(a.c.disabled) - Number(b.c.disabled);
      if (sort === 'name') return a.c.label.localeCompare(b.c.label);
      return sort === 'usage' ? a.used - b.used : a.resetAt - b.resetAt;
    });
    return list.map((r) => r.c);
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
            {creds().length} credentials · <span class="loaded">{loaded()} with quota data</span>
          </div>
        </div>
        <div class="dash-actions">
          <ShowEmailsButton class="btn page-action" />
          <button class="btn page-action solid" disabled={refreshing() || proxyState() !== 'running'} onClick={() => void refreshAll()}>
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
            <h3>No credentials yet</h3>
            <p>Add a subscription login or an API key in AI Providers to start routing requests.</p>
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
          onSelect={pickProvider}
          onLine={pickLine}
        />
        {/* API keys report no limits, so a keys-only view has nothing to chart. */}
        <Show
          when={focused()}
          fallback={
            <Show when={!providerCreds().every((c) => c.apiKey)}>
              <PoolPanel models={chartModels()} windows={chartWindows()} line={lineId()} onLine={pickLine} />
            </Show>
          }
        >
          {(c) => <AccountPanel credential={c()} onClose={() => setChosenAccount(null)} />}
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
        {/* Slots: the most limit bars any row shows, so the bars block is as wide as the fullest row. */}
        <div class="account-list" style={{ '--limit-slots': Math.max(1, ...rows().map((c) => c.windows.length)) }}>
          <For each={rows()} fallback={<div class="empty-state">No accounts match “{query()}”.</div>}>
            {(c) => <AccountRow credential={c} selected={focused()?.id === c.id} onSelect={hasQuota(c) ? () => toggleAccount(c.id) : undefined} />}
          </For>
        </div>
      </Show>
    </>
  );
}
