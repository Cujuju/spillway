import { createMemo, Show } from 'solid-js';
import type { AccountScope, ClientScope } from '@shared/activityScope';
import type { AccountGroup, ClientOption } from '../lib/accountScope';
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

/**
 * The Activity scope as a sentence: "Showing proxy traffic for all accounts from all clients at any effort".
 * `full` off leaves only the usage source (Traces filters the rest itself).
 */
export function ActivityScopeLine(props: {
  full: boolean;
  source: UsageSource; onSource: (v: UsageSource) => void;
  groups: AccountGroup[]; accounts: AccountScope; onAccounts: (v: AccountScope) => void;
  clients: ClientOption[]; clientScope: ClientScope; onClients: (v: ClientScope) => void;
  efforts: string[]; effort: string; onEffort: (v: string) => void;
}) {
  const effortOptions = createMemo(() => [
    { value: ANY_EFFORT, label: 'Any effort', phrase: 'any effort' },
    { value: '', label: 'Unknown effort', phrase: 'unknown effort' },
    ...props.efforts.map((e) => ({ value: e, label: e, phrase: `${e} effort` })),
  ]);
  const narrowed = () => props.source !== 'proxy' || (props.full && (props.accounts !== null || props.clientScope !== null || props.effort !== ANY_EFFORT));
  const reset = () => {
    props.onSource('proxy');
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
      <Show when={narrowed()}><button type="button" class="btn ghost scope-reset" onClick={reset}>Reset</button></Show>
    </div>
  );
}
