import { createMemo, Show } from 'solid-js';
import { ActivityOverview } from '../components/ActivityOverview';
import { ActivityRequests } from '../components/ActivityRequests';
import { ActivityTotals } from '../components/ActivityTotals';
import { Notice, Seg } from '../components/ui';
import { persistedSignal } from '../lib/persisted';
import { proxyStatus, snapshot } from '../store';

const VIEWS = [{ value: 'overview', label: 'Overview' }, { value: 'requests', label: 'Requests' }, { value: 'totals', label: 'Daily totals' }] as const;

export function Activity() {
  const [view, setView] = persistedSignal('activity.view', 'overview', VIEWS.map((v) => v.value));

  // snapshot() is already masked when "Show emails" is off.
  const accountNames = createMemo(() => new Map((snapshot()?.credentials ?? []).map((c) => [c.authIndex, c.label])));
  const accountName = (authIndex: string | null) => (authIndex ? (accountNames().get(authIndex) ?? authIndex) : '—');

  return (
    <>
      <header class="dash-header title-row">
        <h1 class="dash-title">Activity</h1>
        <Seg value={view()} options={VIEWS} onChange={setView} />
      </header>

      <Show when={proxyStatus()?.state !== 'running'}>
        <Notice>New activity appears while the proxy is running.</Notice>
      </Show>

      <Show when={view() === 'overview'}>
        <ActivityOverview />
      </Show>
      <Show when={view() === 'totals'}>
        <ActivityTotals account={accountName} />
      </Show>
      <Show when={view() === 'requests'}>
        <ActivityRequests account={accountName} />
      </Show>
    </>
  );
}
