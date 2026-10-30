import { X } from 'lucide-solid';
import { createMemo, For, Show } from 'solid-js';
import type { Credential } from '@shared/types';
import { persistedSignal } from '../lib/persisted';
import { pastSeries } from '../lib/poolHistory';
import { providerVar } from '../lib/providers';
import { history, now } from '../store';
import { chartFrom } from './poolModel';
import { PastWindows } from './PastWindows';
import { QuotaChart, type QuotaSeries } from './QuotaChart';
import { ProviderGlyph } from './ui';

const ICON_PX = 14;
const FULL = 100;
/** Lines carry every stored sample, so zooming out reaches the start of history. */
const WHOLE_HISTORY = Number.NEGATIVE_INFINITY;
/** The account is its own pool: one share holding all of it. */
const WHOLE_SHARE = { share: 1, cost: {} };
/** The longest window takes the provider colour; shorter ones take these in turn. */
const SHORTER_WINDOW_COLORS = ['var(--color-accent)', 'var(--color-amber)', 'var(--color-green)'];
const TABS = ['remaining', 'past'] as const;

/** Account-wide windows with data, longest first. */
const accountWindows = (c: Credential) =>
  c.windows.filter((w) => !w.scoped && w.usedPercent !== null).sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0));

/** One account's quota: a remaining line per window, and how its past windows ended. Replaces the pool chart while an account is picked. */
export function AccountPanel(props: { credential: Credential; onClose: () => void }) {
  const [tab, setTab] = persistedSignal('dashboard.accountTab', 'remaining', TABS);
  const windows = createMemo(() => accountWindows(props.credential));
  const color = (i: number) => (i === 0 ? providerVar(props.credential.provider) : SHORTER_WINDOW_COLORS[(i - 1) % SHORTER_WINDOW_COLORS.length]!);
  const series = createMemo((): QuotaSeries[] => {
    const c = props.credential;
    const shares = new Map([[c.id, WHOLE_SHARE]]);
    return windows().map((w, i) => ({
      id: w.key,
      label: w.label,
      color: color(i),
      past: [...pastSeries(history(), [c], w.key, WHOLE_HISTORY, shares), { t: now(), remaining: Math.max(0, FULL - w.usedPercent!) }],
    }));
  });
  // Opens on the longest window's whole length, so the current week shows at once.
  const from = () => {
    const longest = windows()[0]?.durationMs;
    return longest ? now() - longest : chartFrom();
  };

  return (
    <section class="summary" style={{ '--pool-color': providerVar(props.credential.provider) }}>
      <div class="summary-tabs">
        <button classList={{ active: tab() === 'remaining' }} onClick={() => setTab('remaining')}>Remaining quota</button>
        <button classList={{ active: tab() === 'past' }} onClick={() => setTab('past')}>Past windows</button>
        <span class="spacer" />
        <div class="legend">
          <Show when={tab() === 'remaining'}>
            <For each={windows()}>{(w, i) => <span style={{ '--pool-color': color(i()) }}><span class="dot" />{w.label}</span>}</For>
          </Show>
          <span class="account-focus">
            <ProviderGlyph provider={props.credential.provider} size="sm" />
            <span class="truncate" title={props.credential.label}>{props.credential.label}</span>
            <button class="btn ghost icon-btn" onClick={() => props.onClose()} title="Back to the pool chart" aria-label="Back to the pool chart">
              <X size={ICON_PX} />
            </button>
          </span>
        </div>
      </div>
      <Show when={windows().length} fallback={<div class="muted">No limit data for this account yet.</div>}>
        <Show
          when={tab() === 'remaining'}
          fallback={<PastWindows credentialId={props.credential.id} window={windows()[0]!} />}
        >
          <QuotaChart series={series()} from={from()} to={now()} now={now()} yMax={() => FULL} yLabel={(v) => `${Math.round(v)}%`} ariaLabel="Account quota chart" />
        </Show>
      </Show>
    </section>
  );
}
