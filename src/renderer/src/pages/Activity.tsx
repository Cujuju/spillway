import { createSignal, onCleanup, createMemo, Show } from 'solid-js';
import { isKeyScope, type AccountScope, type ActivityScope, type ClientScope } from '@shared/activityScope';
import { AccountFilter } from '../components/AccountFilter';
import { ActivityOverview } from '../components/ActivityOverview';
import { ActivityRequests, type RequestFilter } from '../components/ActivityRequests';
import { ActivityTotals } from '../components/ActivityTotals';
import { ClientFilter } from '../components/ClientFilter';
import { Notice, Seg } from '../components/ui';
import { accountGroups, clientOptions } from '../lib/accountScope';
import { createDaySummaries } from '../lib/daySummaries';
import { persistedSignal } from '../lib/persisted';
import { activityBuckets, proxyStatus, snapshot } from '../store';

const VIEWS = [{ value: 'overview', label: 'Overview' }, { value: 'requests', label: 'Requests' }, { value: 'totals', label: 'Daily totals' }] as const;
const FILTERS: readonly RequestFilter[] = ['all', 'failed'];

export function Activity() {
  const [view, setView] = persistedSignal('activity.view', 'overview', VIEWS.map((v) => v.value));
  const [filter, setFilter] = persistedSignal<RequestFilter>('activity.filter', 'all', FILTERS);
  const [accounts, setAccounts] = persistedSignal<AccountScope>('activity.accounts', null, isKeyScope);
  const [clients, setClients] = persistedSignal<ClientScope>('activity.clients', null, isKeyScope);
  const [source, setSource] = persistedSignal<'proxy' | 'all'>('activity.source', 'proxy', ['proxy', 'all']);
  const [revision, setRevision] = createSignal(0);
  onCleanup(window.api.onActivityReset(() => setRevision((n) => n + 1)));
  const scope = createMemo<ActivityScope>(() => (revision(), { accounts: accounts(), clients: clients(), source: source() }));
  const days = createDaySummaries(scope);
  // The stored and failed totals ride on the filter it switches between.
  const filterOptions = createMemo(() => [
    { value: 'all' as const, label: `All ${days.stored().requests.toLocaleString()}` },
    { value: 'failed' as const, label: `Failed ${days.stored().failed.toLocaleString()}` },
  ]);

  // snapshot() is already masked when "Show emails" is off.
  const accountNames = createMemo(() => new Map((snapshot()?.credentials ?? []).map((c) => [c.authIndex, c.label])));
  const accountName = (authIndex: string | null) => (authIndex ? (accountNames().get(authIndex) ?? authIndex) : 'Unknown account');
  const groups = createMemo(() => accountGroups(snapshot()?.credentials ?? [], activityBuckets(), accounts()));
  const clientChoices = createMemo(() => clientOptions(activityBuckets(), clients()));

  return (
    <>
      <header class="dash-header title-row">
        <h1 class="dash-title">Activity</h1>
        <div class="dash-actions card-spaced">
          <Seg value={source()} options={[{ value: 'proxy' as const, label: 'Via proxy' }, { value: 'all' as const, label: 'All usage' }]} onChange={setSource} />
          <AccountFilter groups={groups()} value={accounts()} onChange={setAccounts} />
          <ClientFilter options={clientChoices()} value={clients()} onChange={setClients} />
          <Show when={view() === 'requests'}>
            <Seg value={filter()} options={filterOptions()} onChange={setFilter} />
          </Show>
          <Seg value={view()} options={VIEWS} onChange={setView} />
        </div>
      </header>

      <Show when={proxyStatus()?.state !== 'running'}>
        <Notice>Proxy activity appears while the proxy is running. Local usage syncs automatically.</Notice>
      </Show>

      <Show when={view() === 'overview'}>
        <ActivityOverview scope={scope()} account={accountName} />
      </Show>
      <Show when={view() === 'totals'}>
        <ActivityTotals account={accountName} scope={scope()} />
      </Show>
      <Show when={view() === 'requests'}>
        <ActivityRequests account={accountName} scope={scope()} filter={filter()} days={days} />
      </Show>
    </>
  );
}
