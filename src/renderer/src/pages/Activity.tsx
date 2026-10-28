import { createMemo, Show } from 'solid-js';
import { isAccountScope, type AccountScope } from '@shared/activityScope';
import { AccountFilter } from '../components/AccountFilter';
import { ActivityOverview } from '../components/ActivityOverview';
import { ActivityRequests, type RequestFilter } from '../components/ActivityRequests';
import { ActivityTotals } from '../components/ActivityTotals';
import { Notice, Seg } from '../components/ui';
import { accountGroups } from '../lib/accountScope';
import { createDaySummaries } from '../lib/daySummaries';
import { persistedSignal } from '../lib/persisted';
import { activityBuckets, proxyStatus, snapshot } from '../store';

const VIEWS = [{ value: 'overview', label: 'Overview' }, { value: 'requests', label: 'Requests' }, { value: 'totals', label: 'Daily totals' }] as const;
const FILTERS: readonly RequestFilter[] = ['all', 'failed'];

export function Activity() {
  const [view, setView] = persistedSignal('activity.view', 'overview', VIEWS.map((v) => v.value));
  const [filter, setFilter] = persistedSignal<RequestFilter>('activity.filter', 'all', FILTERS);
  const [accounts, setAccounts] = persistedSignal<AccountScope>('activity.accounts', null, isAccountScope);
  const days = createDaySummaries(accounts);
  // The stored and failed totals ride on the filter it switches between.
  const filterOptions = createMemo(() => [
    { value: 'all' as const, label: `All ${days.stored().requests.toLocaleString()}` },
    { value: 'failed' as const, label: `Failed ${days.stored().failed.toLocaleString()}` },
  ]);

  // snapshot() is already masked when "Show emails" is off.
  const accountNames = createMemo(() => new Map((snapshot()?.credentials ?? []).map((c) => [c.authIndex, c.label])));
  const accountName = (authIndex: string | null) => (authIndex ? (accountNames().get(authIndex) ?? authIndex) : '—');
  const groups = createMemo(() => accountGroups(snapshot()?.credentials ?? [], activityBuckets(), accounts()));

  return (
    <>
      <header class="dash-header title-row">
        <h1 class="dash-title">Activity</h1>
        <div class="dash-actions card-spaced">
          <AccountFilter groups={groups()} value={accounts()} onChange={setAccounts} />
          <Show when={view() === 'requests'}>
            <Seg value={filter()} options={filterOptions()} onChange={setFilter} />
          </Show>
          <Seg value={view()} options={VIEWS} onChange={setView} />
        </div>
      </header>

      <Show when={proxyStatus()?.state !== 'running'}>
        <Notice>New activity appears while the proxy is running.</Notice>
      </Show>

      <Show when={view() === 'overview'}>
        <ActivityOverview accounts={accounts()} />
      </Show>
      <Show when={view() === 'totals'}>
        <ActivityTotals account={accountName} accounts={accounts()} />
      </Show>
      <Show when={view() === 'requests'}>
        <ActivityRequests account={accountName} accounts={accounts()} filter={filter()} days={days} />
      </Show>
    </>
  );
}
