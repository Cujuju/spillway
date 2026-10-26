import { createMemo, createSignal, createUniqueId, For, onCleanup, onMount, Show } from 'solid-js';
import type { SeriesPoint } from '../lib/poolHistory';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Must match `.chart { height }` in dashboard.css. */
const HEIGHT = 300;
const PAD = { left: 48, right: 12, top: 12, bottom: 26 };
const Y_TICKS = 4;
/** Spans up to this many days get 6-hour ticks; longer spans tick daily. */
const HOURLY_TICK_MAX_DAYS = 2;
const HOURLY_TICK_STEP_MS = 6 * HOUR_MS;

export interface QuotaChartProps {
  past: SeriesPoint[];
  /** Dashed projection; omit for history-only charts. */
  future?: SeriesPoint[];
  from: number;
  to: number;
  now: number;
  yMax: number;
  yLabel: (v: number) => string;
  color: string;
}

/** Remaining-quota line: solid history, dashed projection, a "Now" marker (Theo's chart). */
export function QuotaChart(props: QuotaChartProps) {
  let host!: HTMLDivElement;
  const [width, setWidth] = createSignal(800);
  onMount(() => {
    const ro = new ResizeObserver(([e]) => e && setWidth(Math.max(200, e.contentRect.width)));
    ro.observe(host);
    onCleanup(() => ro.disconnect());
  });

  const plotW = () => width() - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const x = (t: number) => PAD.left + ((t - props.from) / Math.max(1, props.to - props.from)) * plotW();
  const y = (v: number) => PAD.top + plotH - (Math.min(props.yMax, Math.max(0, v)) / Math.max(1, props.yMax)) * plotH;
  const path = (pts: SeriesPoint[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.remaining).toFixed(1)}`).join('');
  const area = (pts: SeriesPoint[]) =>
    pts.length ? `${path(pts)}L${x(pts.at(-1)!.t).toFixed(1)},${y(0)}L${x(pts[0]!.t).toFixed(1)},${y(0)}Z` : '';

  const yTicks = createMemo(() => Array.from({ length: Y_TICKS + 1 }, (_, i) => (props.yMax * i) / Y_TICKS));
  const xTicks = createMemo(() => {
    const span = props.to - props.from;
    const daily = span > HOURLY_TICK_MAX_DAYS * DAY_MS;
    const step = daily ? DAY_MS : HOURLY_TICK_STEP_MS;
    const start = new Date(props.from);
    if (daily) start.setHours(24, 0, 0, 0);
    else start.setHours(Math.ceil(start.getHours() / 6) * 6, 0, 0, 0);
    const out: { t: number; label: string }[] = [];
    for (let t = start.getTime(); t <= props.to; t += step) {
      const d = new Date(t);
      out.push({
        t,
        label: daily ? d.toLocaleDateString(undefined, { weekday: 'short' }) : d.toLocaleTimeString(undefined, { hour: 'numeric' }),
      });
    }
    return out;
  });
  const gradientId = `qc-${createUniqueId()}`;

  return (
    <div ref={host}>
      <svg class="chart" width={width()} height={HEIGHT} role="img" aria-label="Remaining quota chart">
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stop-color={props.color} stop-opacity="0.28" />
            <stop offset="1" stop-color={props.color} stop-opacity="0" />
          </linearGradient>
        </defs>
        <For each={yTicks()}>
          {(v) => (
            <>
              <line x1={PAD.left} x2={width() - PAD.right} y1={y(v)} y2={y(v)} stroke="var(--color-border)" stroke-dasharray={v ? '2 4' : undefined} />
              <text x={PAD.left - 8} y={y(v) + 4} text-anchor="end">{props.yLabel(v)}</text>
            </>
          )}
        </For>
        <For each={xTicks()}>
          {(tick) => <text x={x(tick.t)} y={HEIGHT - 6} text-anchor="middle">{tick.label}</text>}
        </For>
        <path d={area(props.past)} fill={`url(#${gradientId})`} />
        <path d={path(props.past)} fill="none" stroke={props.color} stroke-width="2" stroke-linejoin="round" />
        <Show when={props.future?.length}>
          <path d={path(props.future!)} fill="none" stroke={props.color} stroke-width="1.6" stroke-dasharray="5 4" opacity="0.75" />
        </Show>
        <Show when={props.now >= props.from && props.now <= props.to}>
          <line x1={x(props.now)} x2={x(props.now)} y1={PAD.top} y2={y(0)} stroke="var(--color-text-muted)" stroke-dasharray="3 3" />
          <text x={x(props.now)} y={PAD.top + 10} text-anchor="middle" style={{ fill: 'var(--color-text-secondary)' }}>Now</text>
        </Show>
      </svg>
    </div>
  );
}
