import { HoverTip } from './ChartTip';
import { createSignal, Show } from 'solid-js';
import { Lock, RotateCcw } from 'lucide-solid';
import { HoldIndicator, useHoldAction } from '@cujuju/solidjs-hold-action';
import { clockText, resetParts } from '@shared/resetTime';
import type { Credential, ProviderId, ResetCreditOutcome, ResetCredits } from '@shared/types';
import { dateTime } from '../lib/format';
import { now } from '../store';

/** Spending a credit cannot be undone, so it takes a deliberate four-second hold. */
const RESET_HOLD_MS = 4_000;
const HOLD_SECONDS = RESET_HOLD_MS / 1_000;
/** One step above the badge's 10px text, so the glyph reads at badge height. */
const STATE_ICON_PX = 11;

const OUTCOME_TEXT: Record<ResetCreditOutcome, (label: string) => string> = {
  reset: (label) => `Reset applied to ${label}; its limits were re-read.`,
  nothing_to_reset: (label) => `${label} has no limit to clear, so no credit was spent.`,
  no_credit: (label) => `${label} holds no usable reset credit.`,
  already_redeemed: (label) => `That reset for ${label} was already redeemed.`,
};

/** Why no credit is usable, per provider: Codex needs a reached limit; Claude decides per grant. */
const UNUSABLE_NOTE: Partial<Record<ProviderId, string>> = {
  codex: 'Usable once a limit is reached.',
  claude: 'Blocked by Claude for now.',
};
const UNUSABLE_FALLBACK = 'None usable now.';

/** Expiries still ahead; a passed one stays listed only until the next lookup drops it. */
const upcoming = (r: ResetCredits, at: number) => r.expiries.filter((t) => Date.parse(t) > at);

/**
 * The account's reset-credit count, as a badge, and when the soonest credit expires. While a credit
 * is usable, holding the badge spends one.
 */
export function ResetCreditButton(props: {
  credential: Credential;
  disabled: boolean;
  /** False hides the "expires …" text where width is tight; the tooltip still lists expiries. */
  showExpiry?: boolean;
  onDone: (message: string) => void;
  onError: (message: string) => void;
}) {
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
      ? (UNUSABLE_NOTE[props.credential.provider] ?? UNUSABLE_FALLBACK)
      : props.disabled
        ? 'Start the proxy to use one.'
        : `Hold ${HOLD_SECONDS} seconds to use one.`;

  return (
    <>
      <HoverTip title="Rate-limit reset credits" focusable={false} note={action()} rows={[
        { label: 'Held', value: credits().available.toLocaleString() },
        { label: 'Usable now', value: credits().applicable.toLocaleString() },
        ...upcoming(credits(), now()).map((t) => ({ label: 'Expires', value: dateTime(t) })),
        ...(soonest() ? [{ label: 'First expires in', value: resetParts(soonest()!, now()).left }] : []),
        { label: 'Checked', value: dateTime(credits().checkedAt) },
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
            {usable() ? <RotateCcw size={STATE_ICON_PX} aria-hidden="true" /> : <Lock size={STATE_ICON_PX} aria-hidden="true" />}
            {busy() ? 'Resetting…' : `${credits().available} ${credits().available === 1 ? 'reset' : 'resets'}`}
          </span>
        </button>
      </HoverTip>
      <Show when={props.showExpiry !== false && soonest()}>
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
