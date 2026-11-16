import { createMemo, For, Match, Show, Switch } from 'solid-js';
import { Ticket } from 'lucide-solid';
import type { Credential, ResetCredits } from '@shared/types';
import { appLocale } from '@shared/timeFormat';
import { dateTime } from '../lib/format';
import { groupGrants, outcomeText, resetMode, restoresText, SCOPE_NOUN, unusableNote, type GrantGroup, type GrantScope } from '../lib/resetGrants';
import { now } from '../store';
import { ResetHoldBadge } from './ResetHoldBadge';

/** Codex spends by provider default, so its hold binds to this fixed key instead of a grant ID. */
const PROVIDER_DEFAULT = 'provider-default';

const TIP_TITLE: Record<GrantScope, string> = { fable: 'Fable resets', general: 'General resets', unknown: 'Unrecognized resets' };
const SCOPE_LABEL: Record<GrantScope, string> = { fable: 'Fable', general: 'general', unknown: 'unknown' };
/** Matches the badge's state icon at its 10px text size. */
const TICKET_ICON_PX = 11;

const count = (n: number) => n.toLocaleString(appLocale());
const plural = (n: number, noun: string) => `${count(n)} ${noun}${n === 1 ? '' : 's'}`;

/** Expiries still ahead; a passed one stays listed only until the next lookup drops it. */
const upcoming = (r: ResetCredits, at: number) => r.expiries.filter((t) => Date.parse(t) > at);

/**
 * The account's reset credits as hold-to-spend badges. Claude shows one badge per grant scope and
 * spends that scope's grant; Codex shows one badge and spends the provider's default credit.
 */
export function ResetCreditButton(props: {
  credential: Credential;
  disabled: boolean;
  /** False hides the "expires …" text where width is tight; the tooltip still lists expiries. */
  showExpiry?: boolean;
  /** Replace the visible reset noun with a ticket icon. */
  ticketLabel?: boolean;
  onDone: (message: string) => void;
  onError: (message: string) => void;
}) {
  const credits = () => props.credential.resetCredits!;
  const checked = () => ({ label: 'Checked', value: dateTime(credits().checkedAt) });
  const groups = createMemo(() => groupGrants(credits().grants ?? [], now()));
  const label = (available: number, scope?: GrantScope) => props.ticketLabel
    ? <>{count(available)}{scope ? ` ${SCOPE_LABEL[scope]}` : ''} <Ticket size={TICKET_ICON_PX} aria-hidden="true" /></>
    : undefined;

  const spend = async (grantId: string | undefined, scope?: GrantScope) => {
    try {
      const outcome = await window.api.useResetCredit(props.credential.id, grantId);
      props.onDone(outcomeText(outcome, props.credential.label, scope));
    } catch (e) {
      props.onError((e as Error).message);
    }
  };

  const grantRows = (g: GrantGroup) => {
    // Grants in one scope share what they clear; describe the one a hold spends, else the first held.
    const shown = g.target ?? g.grants[0];
    return [
      { label: 'Held', value: count(g.available) },
      { label: 'Usable now', value: count(g.applicable) },
      ...(g.target ? [{ label: 'Spends', value: g.target.label }] : []),
      ...(shown?.clears.length ? [{ label: 'Restores', value: restoresText(shown.clears, props.credential.windows) }] : []),
      checked(),
    ];
  };

  return (
    <Switch>
      <Match when={resetMode(props.credential) === 'grants'}>
        {/* Keyed by scope: groups are rebuilt on every lookup and clock tick, and a re-created badge would drop its hold. */}
        <For each={groups().map((g) => g.scope)}>
          {(scope) => {
            const g = () => groups().find((x) => x.scope === scope)!;
            return (
              <Show when={groups().some((x) => x.scope === scope)}>
                <ResetHoldBadge
                  text={plural(g().available, SCOPE_NOUN[scope])}
                  label={label(g().available, scope)}
                  target={g().target?.id ?? null}
                  disabled={props.disabled}
                  tipTitle={TIP_TITLE[scope]}
                  tipRows={grantRows(g())}
                  unusableNote={unusableNote(g(), now())}
                  spends={`a ${SCOPE_NOUN[scope]}`}
                  expiries={g().expiries}
                  showExpiry={props.showExpiry}
                  onSpend={(id) => spend(id, scope)}
                />
              </Show>
            );
          }}
        </For>
      </Match>
      <Match when={resetMode(props.credential) === 'untyped'}>
        <ResetHoldBadge
          text={plural(credits().available, 'reset')}
          label={label(credits().available)}
          target={null}
          disabled={props.disabled}
          tipTitle="Rate-limit resets"
          tipRows={[{ label: 'Held', value: count(credits().available) }, checked()]}
          unusableNote="Reset type not reported, so it cannot be used. Refresh to look it up."
          spends="a reset"
          expiries={upcoming(credits(), now())}
          showExpiry={props.showExpiry}
        />
      </Match>
      <Match when={resetMode(props.credential) === 'credits'}>
        <ResetHoldBadge
          text={plural(credits().available, 'reset')}
          label={label(credits().available)}
          target={credits().applicable > 0 ? PROVIDER_DEFAULT : null}
          disabled={props.disabled}
          tipTitle="Rate-limit reset credits"
          tipRows={[
            { label: 'Held', value: count(credits().available) },
            { label: 'Usable now', value: count(credits().applicable) },
            checked(),
          ]}
          unusableNote="Not currently redeemable."
          spends="one"
          expiries={upcoming(credits(), now())}
          showExpiry={props.showExpiry}
          onSpend={() => spend(undefined)}
        />
      </Match>
    </Switch>
  );
}
