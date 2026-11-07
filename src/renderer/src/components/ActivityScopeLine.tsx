import { createMemo, Show } from 'solid-js';
import type { AccountScope, ClientScope } from '@shared/activityScope';
import type { AccountGroup, ClientOption } from '../lib/accountScope';
import type { CustomRange, Range } from '../lib/activityRange';
import { AccountFilter } from './AccountFilter';
import { ClientFilter } from './ClientFilter';
import { ChoiceChip } from './ScopeChip';

export type UsageSource = 'proxy' | 'all';
/** The effort filter's "every effort" value; '' is requests with no recorded effort. */
export const ANY_EFFORT = '*';
const SOURCES = [
  { value: 'proxy', label: 'Via proxy', phrase: 'proxy traffic' },
  { value: 'all', label: 'All usage', phrase: 'all usage' },
] as const;
/** The time frame the Overview opens on. */
export const DEFAULT_RANGE: Range = '7d';
const RANGE_OPTIONS: readonly { value: Range; label: string; phrase: string }[] = [
  { value: '24h', label: 'Last 24 hours', phrase: 'the last 24 hours' },
  { value: '7d', label: 'Last 7 days', phrase: 'the last 7 days' },
  { value: '30d', label: 'Last 30 days', phrase: 'the last 30 days' },
  { value: '90d', label: 'Last 90 days', phrase: 'the last 90 days' },
  { value: '1y', label: 'Last year', phrase: 'the last year' },
  { value: 'all', label: 'All time', phrase: 'all time' },
  { value: 'custom', label: 'Custom dates', phrase: 'custom dates' },
];

const shortDay = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

/** The Overview's time frame: a preset, or inclusive days up to `today`. */
export interface TimeFrame { range: Range; custom: CustomRange; today: string; onRange: (v: Range) => void; onCustom: (v: CustomRange) => void }

/** The Activity scope as a sentence. `full` off keeps only the usage source (Traces); `time` adds "over the last 7 days". */
export function ActivityScopeLine(props: {
  full: boolean;
  source: UsageSource; onSource: (v: UsageSource) => void;
  groups: AccountGroup[]; accounts: AccountScope; onAccounts: (v: AccountScope) => void;
  clients: ClientOption[]; clientScope: ClientScope; onClients: (v: ClientScope) => void;
  efforts: string[]; effort: string; onEffort: (v: string) => void;
  time?: TimeFrame;
}) {
  const effortOptions = createMemo(() => [
    { value: ANY_EFFORT, label: 'Any effort', phrase: 'any effort' },
    { value: '', label: 'Unknown effort', phrase: 'unknown effort' },
    ...props.efforts.map((e) => ({ value: e, label: e, phrase: `${e} effort` })),
  ]);
  const narrowed = () => props.source !== 'proxy' || (props.time !== undefined && props.time.range !== DEFAULT_RANGE)
    || (props.full && (props.accounts !== null || props.clientScope !== null || props.effort !== ANY_EFFORT));
  const reset = () => {
    props.onSource('proxy');
    props.time?.onRange(DEFAULT_RANGE);
    if (!props.full) return;
    props.onAccounts(null); props.onClients(null); props.onEffort(ANY_EFFORT);
  };
  return (
    <div class="scope-line" role="group" aria-label="Activity scope">
      <span>Showing</span>
      <ChoiceChip label="Usage" value={props.source} initial="proxy" options={SOURCES} onChange={props.onSource} />
      <Show when={props.full}>
        <span>for</span>
        <AccountFilter groups={props.groups} value={props.accounts} onChange={props.onAccounts} />
        <span>from</span>
        <ClientFilter options={props.clients} value={props.clientScope} onChange={props.onClients} />
        <span>at</span>
        <ChoiceChip label="Effort" value={props.effort} initial={ANY_EFFORT} options={effortOptions()} onChange={props.onEffort} />
      </Show>
      <Show when={props.time}>{(t) => <>
        <span>over</span>
        <ChoiceChip label="Time frame" value={t().range} initial={DEFAULT_RANGE} options={RANGE_OPTIONS} onChange={t().onRange}
          phrase={t().range === 'custom' ? `${shortDay(t().custom.from)} – ${shortDay(t().custom.to)}` : undefined}
          opensMore="custom" extra={
            <Show when={t().range === 'custom'}>
              <div class="scope-dates">
                <input type="date" class="input" aria-label="From" value={t().custom.from} max={t().custom.to}
                  onChange={(e) => e.currentTarget.value && t().onCustom({ ...t().custom, from: e.currentTarget.value })} />
                <input type="date" class="input" aria-label="To" value={t().custom.to} min={t().custom.from} max={t().today}
                  onChange={(e) => e.currentTarget.value && t().onCustom({ ...t().custom, to: e.currentTarget.value })} />
              </div>
            </Show>
          } />
      </>}</Show>
      <Show when={narrowed()}><button type="button" class="btn ghost scope-reset" onClick={reset}>Reset</button></Show>
    </div>
  );
}
