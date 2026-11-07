import { ActivityImport } from '../components/ActivityImport';
import { RequestArchive } from '../components/RequestArchive';
import { SessionTraces } from '../components/SessionTraces';
import { createMemo, createSignal, onCleanup, Show } from 'solid-js';
import { isKeyScope, type AccountScope, type ActivityScope, type ClientScope } from '@shared/activityScope';
import { ActivityScopeLine, ANY_EFFORT, DEFAULT_RANGE, type TimeFrame } from '../components/ActivityScopeLine';
import { DEFAULT_TRACE_FILTERS, TraceLimitNote, type TraceFilters } from '../components/TraceScopeParts';
import type { ArchiveFilters } from '../lib/archiveViewQuery';
import { TRACE_MAX_DAYS } from '@shared/sessionTrace';
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

const VIEWS = [{ value: 'overview', label: 'Overview' }, { value: 'requests', label: 'Requests' }, { value: 'archive', label: 'Archive' }, { value: 'traces', label: 'Traces' }, { value: 'totals', label: 'Totals' }] as const;
const FILTERS: readonly RequestFilter[] = ['all', 'failed'];
/** Default custom span: the last 30 days. */
const DEFAULT_CUSTOM_DAYS = 30;
/** Default Traces custom span: the last 7 days. */
const DEFAULT_TRACE_CUSTOM_DAYS = 7;
/** Presets within TRACE_MAX_DAYS. */
const TRACE_RANGES: readonly Range[] = ['24h', '7d', '30d', '90d', 'custom'];
/** The Archive opens on every record it holds; retention and the byte budget already bound it. */
const ARCHIVE_DEFAULT_RANGE: Range = 'all';
const DAY_MS = 24 * 60 * 60 * 1000;
const lastDays = (days: number): CustomRange => ({ from: dayText(Date.now() - (days - 1) * DAY_MS), to: dayText(Date.now()) });

export function Activity() {
  const [view, setView] = persistedSignal('activity.view', 'overview', VIEWS.map((v) => v.value));
  const [filter, setFilter] = persistedSignal<RequestFilter>('activity.filter', 'all', FILTERS);
  const [accounts, setAccounts] = persistedSignal<AccountScope>('activity.accounts', null, isKeyScope);
  const [clients, setClients] = persistedSignal<ClientScope>('activity.clients', null, isKeyScope);
  const [source, setSource] = persistedSignal<'proxy' | 'all'>('activity.source', 'proxy', ['proxy', 'all']);
  const [period, setPeriod] = persistedSignal<TotalsPeriod>('activity.totalsPeriod', 'day', TOTALS_PERIODS.map((p) => p.value));
  const [effort, setEffort] = persistedSignal<string>('activity.effort', ANY_EFFORT, (v): v is string => typeof v === 'string');
  const [range, setRange] = persistedSignal<Range>('activity.range', DEFAULT_RANGE, RANGES);
  const [custom, setCustom] = persistedSignal<CustomRange>('activity.customRange', lastDays(DEFAULT_CUSTOM_DAYS), isCustomRange);
  const [traceRange, setTraceRange] = persistedSignal<Range>('activity.traceRange', DEFAULT_RANGE, TRACE_RANGES);
  const [traceCustom, setTraceCustom] = persistedSignal<CustomRange>('activity.traceCustomRange', lastDays(DEFAULT_TRACE_CUSTOM_DAYS), isCustomRange);
  const [traceFilters, setTraceFilters] = createSignal<TraceFilters>(DEFAULT_TRACE_FILTERS);
  const filterTraces = (patch: Partial<TraceFilters>) => setTraceFilters((f) => ({ ...f, ...patch }));
  const [traceLimit, setTraceLimit] = createSignal<number>();
  const [archiveRange, setArchiveRange] = persistedSignal<Range>('activity.archiveRange', ARCHIVE_DEFAULT_RANGE, RANGES);
  const [archiveCustom, setArchiveCustom] = persistedSignal<CustomRange>('activity.archiveCustomRange', lastDays(DEFAULT_TRACE_CUSTOM_DAYS), isCustomRange);
  const [archiveFilters, setArchiveFilters] = createSignal<ArchiveFilters>({});
  const filterArchive = (patch: Partial<ArchiveFilters>) => setArchiveFilters((f) => ({ ...f, ...patch }));
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
  const timeFrame = (): TimeFrame | undefined => {
    if (view() === 'overview') return { range: range(), custom: custom(), today: dayText(now()), onRange: setRange, onCustom: setCustom };
    if (view() === 'traces') return { range: traceRange(), custom: traceCustom(), today: dayText(now()), onRange: setTraceRange, onCustom: setTraceCustom, ranges: TRACE_RANGES, maxDays: TRACE_MAX_DAYS };
    if (view() === 'archive') return { range: archiveRange(), custom: archiveCustom(), today: dayText(now()), onRange: setArchiveRange, onCustom: setArchiveCustom, initial: ARCHIVE_DEFAULT_RANGE };
    return undefined;
  };

  return (
    <>
      <PageHeader class="tabbed" below={
        <div class="scope-row">
          <ActivityScopeLine full={view() !== 'traces' && view() !== 'archive'} source={source()} onSource={setSource}
            groups={groups()} accounts={accounts()} onAccounts={setAccounts}
            clients={clientChoices()} clientScope={clients()} onClients={setClients}
            efforts={efforts()} effort={effort()} onEffort={setEffort}
            traces={view() === 'traces' ? { value: traceFilters(), onChange: filterTraces } : undefined}
            archive={view() === 'archive' ? { value: archiveFilters(), onChange: filterArchive } : undefined} time={timeFrame()} />
          <div class="scope-row-end">
            <Show when={view() === 'overview'}><AddChartSelect onPick={setPlacing} /></Show>
            <Show when={view() === 'traces' && traceLimit()}>{(n) => <TraceLimitNote limit={n()} />}</Show>
            <Show when={view() === 'totals'}>
              <Seg label="Group by" value={period()} options={TOTALS_PERIODS} onChange={setPeriod} />
            </Show>
            <Show when={view() === 'requests'}>
              <Seg label="Requests shown" value={filter()} options={filterOptions()} onChange={setFilter} />
            </Show>
          </div>
        </div>
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
      <Show when={view() === 'archive'}><RequestArchive filters={archiveFilters()} onFilters={filterArchive} window={{ range: archiveRange(), custom: archiveCustom() }} /></Show>
      <Show when={view() === 'traces'}><SessionTraces account={accountName} source={source()} filters={traceFilters()} onFilters={filterTraces} onLimit={setTraceLimit} window={{ range: traceRange(), custom: traceCustom() }} /></Show>
      <Show when={view() === 'totals'}>
        <ActivityTotals account={accountName} scope={scope()} period={period()} />
      </Show>
      <Show when={view() === 'requests'}>
        <ActivityRequests account={accountName} scope={scope()} filter={filter()} days={days} />
      </Show>
    </>
  );
}
