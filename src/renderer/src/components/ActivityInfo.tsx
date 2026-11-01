import { Info } from 'lucide-solid';
import { createMemo, createResource, createSignal, onCleanup } from 'solid-js';
import { dateTime, pct } from '../lib/format';
import { HoverTip, type TipRow } from './ChartTip';

/** Date the price table in src/shared/modelPrices.ts was checked. */
const PRICES_CHECKED = 'Oct 26, 2026';
/** Coverage changes slowly; a minute keeps it current without re-querying every request burst. */
const COVERAGE_REFRESH_MS = 60_000;
const ICON_PX = 14;
const COST_NOTE = 'API cost is what the same tokens would cost on the pay-as-you-go API, not what a subscription charges.';
const COVERAGE_NOTE = 'Coverage matches Claude Code and Codex logs to proxy requests by session or response ID.';

/** How the Overview's numbers are made: API cost pricing and how much client traffic went through the proxy. */
export function ActivityInfo(props: { unpriced: string[] }) {
  const [revision, setRevision] = createSignal(0);
  onCleanup(window.api.onActivityReset(() => setRevision((n) => n + 1)));
  const [coverage, { refetch }] = createResource(revision, () => window.api.activityCoverage());
  const timer = setInterval(() => void refetch(), COVERAGE_REFRESH_MS);
  onCleanup(() => clearInterval(timer));

  const clients = createMemo(() => (coverage()?.clients ?? []).filter((c) => c.requests > 0));
  const rows = createMemo((): TipRow[] => {
    const since = coverage()?.since;
    return [
      { label: 'Prices checked', value: PRICES_CHECKED },
      { label: 'Cache writes', value: '5-minute rate' },
      ...(props.unpriced.length ? [{ label: 'No price (left out)', value: props.unpriced.join(', ') }] : []),
      ...(since && clients().length ? [{ label: 'Proxy coverage since', value: dateTime(since) }] : []),
      ...clients().map((c) => ({
        label: c.client ?? c.provider,
        value: `${pct((c.viaProxy / c.requests) * 100)} via proxy (${(c.requests - c.viaProxy).toLocaleString()} bypassed)`,
      })),
    ];
  });

  return (
    <HoverTip title="About these numbers" rows={rows()}
      note={`${COST_NOTE}${clients().length ? ` ${COVERAGE_NOTE}` : ''}`}>
      <span class="activity-info" aria-label="About these numbers"><Info size={ICON_PX} /></span>
    </HoverTip>
  );
}
