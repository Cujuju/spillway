import { ActivityImport } from '../components/ActivityImport';
import { RequestArchive } from '../components/RequestArchive';
import { SessionTraces } from '../components/SessionTraces';
import { createMemo, createSignal, onCleanup, Show } from 'solid-js';
import { isKeyScope, type AccountScope, type ActivityScope, type ClientScope } from '@shared/activityScope';
import { ActivityScopeLine, ANY_EFFORT, DEFAULT_RANGE } from '../components/ActivityScopeLine';
import { AddChartSelect, type PendingChart } from '../components/ActivityBoard';
import { dayText, isCustomRange, RANGES, type CustomRange, type Range } from '../lib/activityRange';
import { ActivityOverview } from '../components/ActivityOverview';
import { ActivityRequests, type RequestFilter } from '../components/ActivityRequests';
import { ActivityTotals } from '../components/ActivityTotals';
import { Notice, Seg, Tabs } from '../components/ui';
import { accountGroups, clientOptions } from '../lib/accountScope';
import { createDaySummaries } from '../lib/daySummaries';
import { persistedSignal } from '../lib/persisted';
import { TOTALS_PERIODS, type TotalsPeriod } from '../lib/totalsPeriod';
import { activityBuckets, now, proxyStatus, snapshot } from '../store';
import { PageHeader } from '../components/PageHeader';

const VIEWS = [{ value: 'overview', label: 'Overview' }, { value: 'requests', label: 'Requests' }, { value: 'traces', label: 'Traces' }, { value: 'archive', label: 'Archive' }, { value: 'totals', label: 'Totals' }] as const;
const FILTERS: readonly RequestFilter[] = ['all', 'failed'];
/** Default custom span: the last 30 days. */
const DEFAULT_CUSTOM_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export function Activity() {
  const [view, setView] = persistedSignal('activity.view', 'overview', VIEWS.map((v) => v.value));
  const [filter, setFilter] = persistedSignal<RequestFilter>('activity.filter', 'all', FILTERS);
  const [accounts, setAccounts] = persistedSignal<AccountScope>('activity.accounts', null, isKeyScope);
  const [clients, setClients] = persistedSignal<ClientScope>('activity.clients', null, isKeyScope);
  const [source, setSource] = persistedSignal<'proxy' | 'all'>('activity.source', 'proxy', ['proxy', 'all']);
  const [period, setPeriod] = persistedSignal<TotalsPeriod>('activity.totalsPeriod', 'day', TOTALS_PERIODS.map((p) => p.value));
  const [effort, setEffort] = persistedSignal<string>('activity.effort', ANY_EFFORT, (v): v is string => typeof v === 'string');
  const [range, setRange] = persistedSignal<Range>('activity.range', DEFAULT_RANGE, RANGES);
  const [custom, setCustom] = persistedSignal<CustomRange>('activity.customRange',
    { from: dayText(Date.now() - (DEFAULT_CUSTOM_DAYS - 1) * DAY_MS), to: dayText(Date.now()) }, isCustomRange);
  const [placing, setPlacing] = createSignal<PendingChart | null>(null);
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
      <PageHeader class="tabbed" below={
        <Show when={view() !== 'archive'}>
          <div class="scope-row">
            <ActivityScopeLine full={view() !== 'traces'} source={source()} onSource={setSource}
              groups={groups()} accounts={accounts()} onAccounts={setAccounts}
              clients={clientChoices()} clientScope={clients()} onClients={setClients}
              efforts={efforts()} effort={effort()} onEffort={setEffort}
              time={view() === 'overview' ? { range: range(), custom: custom(), today: dayText(now()), onRange: setRange, onCustom: setCustom } : undefined} />
            <div class="scope-row-end">
              <Show when={view() === 'overview'}><AddChartSelect onPick={setPlacing} /></Show>
              <Show when={view() === 'totals'}>
                <Seg label="Group by" value={period()} options={TOTALS_PERIODS} onChange={setPeriod} />
              </Show>
              <Show when={view() === 'requests'}>
                <Seg label="Requests shown" value={filter()} options={filterOptions()} onChange={setFilter} />
              </Show>
            </div>
          </div>
        </Show>
      }>
        <h1 class="dash-title">Activity</h1>
        <Tabs class="header-tabs" label="Activity views" value={view()} options={VIEWS} onChange={setView} />
        <span class="header-status"><ActivityImport /></span>
      </PageHeader>

      <Show when={proxyStatus()?.state !== 'running'}>
        <Notice>Proxy activity appears while the proxy is running. Local usage syncs automatically.</Notice>
      </Show>

      <Show when={view() === 'overview'}>
        <ActivityOverview scope={scope()} account={accountName} range={range()} custom={custom()} placing={placing()} onPlacingEnd={() => setPlacing(null)} />
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
