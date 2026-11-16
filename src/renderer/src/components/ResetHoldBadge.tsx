import { HoverTip, type TipRow } from './ChartTip';
import { createSignal, Show, type JSX } from 'solid-js';
import { Lock, RotateCcw } from 'lucide-solid';
import { HoldIndicator, useHoldAction } from '@cujuju/solidjs-hold-action';
import { clockText, resetParts } from '@shared/resetTime';
import { dateTime } from '../lib/format';
import { createHoldBinding } from '../lib/resetGrants';
import { now } from '../store';

/** Spending a credit cannot be undone, so it takes a deliberate four-second hold. */
const RESET_HOLD_MS = 4_000;
const HOLD_SECONDS = RESET_HOLD_MS / 1_000;
/** One step above the badge's 10px text, so the glyph reads at badge height. */
const STATE_ICON_PX = 11;

/**
 * One spendable kind of reset as a badge. Holding it spends `target()`, the ID bound when the hold
 * started; a change of target mid-hold cancels the hold.
 */
export function ResetHoldBadge(props: {
  /** Badge text, e.g. "2 Fable resets". */
  text: string;
  /** Optional visual label; `text` remains the accessible description. */
  label?: JSX.Element;
  /** The ID a hold spends; null when nothing is usable. */
  target: string | null;
  /** True while the proxy cannot take the request. */
  disabled: boolean;
  tipTitle: string;
  tipRows: TipRow[];
  /** Tooltip note when `target` is null. */
  unusableNote: string;
  /** What a hold spends, for the accessible label, e.g. "a Fable reset". */
  spends: string;
  /** Known expiries still ahead, soonest first. */
  expiries: string[];
  showExpiry?: boolean;
  /** Absent for a badge that can never be spent. */
  onSpend?: (target: string) => Promise<void>;
}) {
  const [busy, setBusy] = createSignal(false);
  const usable = () => props.target !== null && props.onSpend !== undefined;
  const enabled = () => usable() && !props.disabled && !busy();
  // Losing the proxy mid-hold counts as a target change, so the hold stops.
  const spendable = () => (props.disabled ? null : props.target);
  const soonest = () => props.expiries[0];

  const spend = async (id: string) => {
    setBusy(true);
    try {
      await props.onSpend?.(id);
    } finally {
      setBusy(false);
    }
  };
  const hold = useHoldAction({
    durationMs: RESET_HOLD_MS,
    enabled,
    onCancel: () => binding.release(),
    onComplete: () => {
      const id = binding.take();
      if (id !== null) void spend(id);
    },
  });
  const binding = createHoldBinding(spendable, () => hold.cancel());

  const note = () =>
    !usable() ? props.unusableNote : props.disabled ? 'Start the proxy to use one.' : `Hold ${HOLD_SECONDS} seconds to use one.`;

  return (
    <>
      <HoverTip title={props.tipTitle} focusable={false} note={note()} rows={[
        ...props.tipRows,
        ...props.expiries.map((t) => ({ label: 'Expires', value: dateTime(t) })),
        ...(soonest() ? [{ label: 'First expires in', value: resetParts(soonest()!, now()).left }] : []),
      ]}>
        <button
          type="button"
          class="badge hold-badge"
          classList={{ accent: usable() }}
          disabled={!enabled()}
          aria-label={usable() ? `${props.text}. Hold ${HOLD_SECONDS} seconds to use ${props.spends}.` : `${props.text}. ${props.unusableNote}`}
          {...hold.handlers}
          onPointerDown={(e) => {
            hold.handlers.onPointerDown(e);
            if (hold.holding()) binding.bind();
          }}
          onClick={(e) => hold.shouldSuppressClick() && e.preventDefault()}
        >
          <Show when={hold.holding()}>
            <HoldIndicator progress={hold.progress} shape="bar" stroke="var(--color-accent-border)" />
          </Show>
          <span class="hold-label">
            {usable() ? <RotateCcw size={STATE_ICON_PX} aria-hidden="true" /> : <Lock size={STATE_ICON_PX} aria-hidden="true" />}
            {busy() ? 'Resetting…' : (props.label ?? props.text)}
          </span>
        </button>
      </HoverTip>
      <Show when={props.showExpiry !== false && soonest()}>
        {(t) => (
          <HoverTip title="Reset expiry" rows={[
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
