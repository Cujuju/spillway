import { createSignal, Show } from 'solid-js';
import { HoldIndicator, useHoldAction } from '@cujuju/solidjs-hold-action';
import type { Credential, ResetCreditOutcome } from '@shared/types';

/** Spending a credit cannot be undone, so it takes a deliberate four-second hold. */
const RESET_HOLD_MS = 4_000;
const HOLD_SECONDS = RESET_HOLD_MS / 1_000;

const OUTCOME_TEXT: Record<ResetCreditOutcome, (label: string) => string> = {
  reset: (label) => `Reset applied to ${label}; its reached limits are cleared.`,
  nothing_to_reset: (label) => `${label} has no limit reached, so no credit was spent.`,
  no_credit: (label) => `${label} holds no reset credit.`,
  already_redeemed: (label) => `That reset for ${label} was already redeemed.`,
};

/**
 * Press and hold to spend one of a Codex account's rate-limit reset credits. Only enabled while a
 * credit is usable, i.e. the account has reached a limit.
 */
export function ResetCreditButton(props: { credential: Credential; disabled: boolean; onDone: (message: string) => void; onError: (message: string) => void }) {
  const [busy, setBusy] = createSignal(false);
  const usable = () => (props.credential.resetCredits?.applicable ?? 0) > 0;
  const enabled = () => usable() && !props.disabled && !busy();

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

  const title = () =>
    props.disabled
      ? 'Start the proxy first'
      : usable()
        ? `Hold ${HOLD_SECONDS} seconds to spend one reset credit and clear this account's reached limits`
        : 'Usable once this account reaches a limit';

  return (
    <button
      type="button"
      class="btn ghost hold-btn"
      disabled={!enabled()}
      title={title()}
      {...hold.handlers}
      onClick={(e) => hold.shouldSuppressClick() && e.preventDefault()}
    >
      <Show when={hold.holding()}>
        <HoldIndicator progress={hold.progress} shape="bar" stroke="var(--color-accent-border)" />
      </Show>
      <span class="hold-label">{busy() ? 'Resetting…' : hold.holding() ? 'Keep holding…' : 'Use reset'}</span>
    </button>
  );
}
