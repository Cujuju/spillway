import { HoverTip } from './ChartTip';
import { createSignal, Show } from 'solid-js';
import { HoldIndicator, useHoldAction } from '@cujuju/solidjs-hold-action';
import { clockText, resetParts } from '@shared/resetTime';
import type { Credential, ResetCreditOutcome, ResetCredits } from '@shared/types';
import { dateTime } from '../lib/format';
import { now } from '../store';

/** Spending a credit cannot be undone, so it takes a deliberate four-second hold. */
const RESET_HOLD_MS = 4_000;
const HOLD_SECONDS = RESET_HOLD_MS / 1_000;

const OUTCOME_TEXT: Record<ResetCreditOutcome, (label: string) => string> = {
  reset: (label) => `Reset applied to ${label}; its reached limits are cleared.`,
  nothing_to_reset: (label) => `${label} has no limit reached, so no credit was spent.`,
  no_credit: (label) => `${label} holds no reset credit.`,
  already_redeemed: (label) => `That reset for ${label} was already redeemed.`,
};

/** Expiries still ahead; a passed one stays listed only until the next lookup drops it. */
const upcoming = (r: ResetCredits, at: number) => r.expiries.filter((t) => Date.parse(t) > at);

/**
 * The account's reset-credit count, as a badge, and when the soonest credit expires. While a credit
 * is usable (the account has reached a limit), holding the badge spends one.
 */
export function ResetCreditButton(props: { credential: Credential; disabled: boolean; onDone: (message: string) => void; onError: (message: string) => void }) {
  const [busy, setBusy] = createSignal(false);
  const credits = () => props.credential.resetCredits!;
  const usable = () => credits().applicable > 0;
  const enabled = () => usable() && !props.disabled && !busy();
  const soonest = () => upcoming(credits(), now())[0];

  const spend = async () => {
    setBusy(true);
    try {
      const outcome = await window.api.useResetCredit(props.credential.id);
      props.onDone(OUTCOME_TEXT[outcome](props.credential.label));
    } catch (e) {
      props.onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const hold = useHoldAction({ durationMs: RESET_HOLD_MS, enabled, onComplete: () => void spend() });

  const action = () =>
    !usable()
      ? 'A reset clears a limit the account has reached.'
      : props.disabled
        ? 'Start the proxy to use one.'
        : `Hold ${HOLD_SECONDS} seconds to spend one and clear this account's reached limits.`;

  return (
    <>
      <HoverTip title="Rate-limit reset credits" focusable={false} rows={[
        { label: 'Held', value: credits().available.toLocaleString() },
        { label: 'Usable now', value: credits().applicable.toLocaleString() },
        ...upcoming(credits(), now()).map((t) => ({ label: 'Expires', value: `${dateTime(t)} · ${resetParts(t, now()).left}` })),
        { label: 'Checked', value: dateTime(credits().checkedAt) },
        { label: 'Action', value: action().replace(/\.$/, '') },
      ]}>
        <button
          type="button"
          class="badge hold-badge"
          classList={{ accent: usable() }}
          disabled={!enabled()}
          {...hold.handlers}
          onClick={(e) => hold.shouldSuppressClick() && e.preventDefault()}
        >
          <Show when={hold.holding()}>
            <HoldIndicator progress={hold.progress} shape="bar" stroke="var(--color-accent-border)" />
          </Show>
          <span class="hold-label">
            {busy() ? 'Resetting…' : `${credits().available} ${credits().available === 1 ? 'reset' : 'resets'}`}
          </span>
        </button>
      </HoverTip>
      <Show when={soonest()}>
        {(t) => (
          <HoverTip title="Reset credit expiry" rows={[
            { label: 'At', value: dateTime(t()) },
            { label: 'In', value: resetParts(t(), now()).left },
          ]}><span class="muted">
            expires {clockText(Date.parse(t()), now())}
          </span></HoverTip>
        )}
      </Show>
    </>
  );
}
