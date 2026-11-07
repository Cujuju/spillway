import { ActivityImport } from '../components/ActivityImport';
import { RequestArchive } from '../components/RequestArchive';
import { SessionTraces } from '../components/SessionTraces';
import { createMemo, createSignal, onCleanup, Show } from 'solid-js';
import { isKeyScope, type AccountScope, type ActivityScope, type ClientScope } from '@shared/activityScope';
import { ActivityScopeLine, ANY_EFFORT } from '../components/ActivityScopeLine';
import { ActivityOverview } from '../components/ActivityOverview';
import { ActivityRequests, type RequestFilter } from '../components/ActivityRequests';
import { ActivityTotals } from '../components/ActivityTotals';
import { Notice, Seg, Tabs } from '../components/ui';
import { accountGroups, clientOptions } from '../lib/accountScope';
import { createDaySummaries } from '../lib/daySummaries';
import { persistedSignal } from '../lib/persisted';
import { TOTALS_PERIODS, type TotalsPeriod } from '../lib/totalsPeriod';
import { activityBuckets, proxyStatus, snapshot } from '../store';
import { PageHeader } from '../components/PageHeader';

const VIEWS = [{ value: 'overview', label: 'Overview' }, { value: 'requests', label: 'Requests' }, { value: 'traces', label: 'Traces' }, { value: 'archive', label: 'Archive' }, { value: 'totals', label: 'Totals' }] as const;
const FILTERS: readonly RequestFilter[] = ['all', 'failed'];

export function Activity() {
  const [view, setView] = persistedSignal('activity.view', 'overview', VIEWS.map((v) => v.value));
  const [filter, setFilter] = persistedSignal<RequestFilter>('activity.filter', 'all', FILTERS);
  const [accounts, setAccounts] = persistedSignal<AccountScope>('activity.accounts', null, isKeyScope);
  const [clients, setClients] = persistedSignal<ClientScope>('activity.clients', null, isKeyScope);
  const [source, setSource] = persistedSignal<'proxy' | 'all'>('activity.source', 'proxy', ['proxy', 'all']);
  const [period, setPeriod] = persistedSignal<TotalsPeriod>('activity.totalsPeriod', 'day', TOTALS_PERIODS.map((p) => p.value));
  const [effort, setEffort] = persistedSignal<string>('activity.effort', ANY_EFFORT, (v): v is string => typeof v === 'string');
  const [revision, setRevision] = createSignal(0);
  onCleanup(window.api.onActivityReset(() => setRevision((n) => n + 1)));
  const scope = createMemo<ActivityScope>(() => (revision(), { accounts: accounts(), clients: clients(), source: source(), efforts: effort() === ANY_EFFORT ? null : [effort()] }));
  const efforts = createMemo(() => [...new Set([...activityBuckets().map((r) => r.reasoningEffort ?? ''), ...(effort() === ANY_EFFORT ? [] : [effort()])])].filter(Boolean).sort());
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
      <PageHeader class="title-row" tabs={
        <Tabs class="page-tabs" label="Activity views" value={view()} options={VIEWS} onChange={setView}>
          <Show when={view() === 'totals'}>
            <Seg label="Group by" value={period()} options={TOTALS_PERIODS} onChange={setPeriod} />
          </Show>
          <Show when={view() === 'requests'}>
            <Seg label="Requests shown" value={filter()} options={filterOptions()} onChange={setFilter} />
          </Show>
        </Tabs>
      }>
        <h1 class="dash-title">Activity</h1>
        <ActivityImport />
        <Show when={view() !== 'archive'}>
          <ActivityScopeLine full={view() !== 'traces'} source={source()} onSource={setSource}
            groups={groups()} accounts={accounts()} onAccounts={setAccounts}
            clients={clientChoices()} clientScope={clients()} onClients={setClients}
            efforts={efforts()} effort={effort()} onEffort={setEffort} />
        </Show>
      </PageHeader>

      <Show when={proxyStatus()?.state !== 'running'}>
        <Notice>Proxy activity appears while the proxy is running. Local usage syncs automatically.</Notice>
      </Show>

      <Show when={view() === 'overview'}>
        <ActivityOverview scope={scope()} account={accountName} />
      </Show>
      <Show when={view() === 'archive'}><RequestArchive /></Show>
      <Show when={view() === 'traces'}><SessionTraces account={accountName} source={source()} /></Show>
      <Show when={view() === 'totals'}>
        <ActivityTotals account={accountName} scope={scope()} period={period()} />
      </Show>
      <Show when={view() === 'requests'}>
        <ActivityRequests account={accountName} scope={scope()} filter={filter()} days={days} />
      </Show>
    </>
  );
}
