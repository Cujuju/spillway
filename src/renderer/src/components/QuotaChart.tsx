import { createMemo, createSignal, createUniqueId, For, onCleanup, onMount, Show } from 'solid-js';
import type { SeriesPoint } from '../lib/poolHistory';
import { valueAt } from '../lib/poolWindows';
import { dayTime } from '../lib/format';
import { ChartTip } from './ChartTip';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const PAD = { left: 48, right: 12, top: 12, bottom: 26 };
const Y_TICKS = 4;
/** Spans up to this many days get 6-hour ticks; longer spans tick daily. */
const HOURLY_TICK_MAX_DAYS = 2;
const HOURLY_TICK_STEP_MS = 6 * HOUR_MS;
/** Arrow keys move the readout by this share of the span. */
const KEY_STEPS = 96;
const HOVER_DOT_RADIUS = 4;

export interface QuotaSeries {
  id: string;
  label: string;
  color: string;
  past: SeriesPoint[];
  /** Dashed projection; omit for history-only charts. */
  future?: SeriesPoint[];
}

export interface QuotaChartProps {
  series: QuotaSeries[];
  from: number;
  to: number;
  now: number;
  yMax: number;
  yLabel: (v: number) => string;
  ariaLabel: string;
}

/** Lines over time: solid history, dashed projection, a "Now" marker, and a crosshair readout. Fills its host's height. */
export function QuotaChart(props: QuotaChartProps) {
  let host!: HTMLDivElement;
  const [width, setWidth] = createSignal(800);
  const [height, setHeight] = createSignal(0);
  const [hoverT, setHoverT] = createSignal<number | null>(null);
  const [pointer, setPointer] = createSignal({ x: 0, y: 0 });
  onMount(() => {
    const ro = new ResizeObserver(([e]) => {
      if (!e) return;
      setWidth(Math.max(200, e.contentRect.width));
      setHeight(e.contentRect.height);
    });
    ro.observe(host);
    onCleanup(() => ro.disconnect());
  });

  const plotW = () => width() - PAD.left - PAD.right;
  const plotH = () => height() - PAD.top - PAD.bottom;
  const span = () => Math.max(1, props.to - props.from);
  const x = (t: number) => PAD.left + ((t - props.from) / span()) * plotW();
  const tAt = (px: number) => props.from + ((px - PAD.left) / plotW()) * span();
  const y = (v: number) => PAD.top + plotH() - (Math.min(props.yMax, Math.max(0, v)) / Math.max(1, props.yMax)) * plotH();
  const path = (pts: SeriesPoint[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.remaining).toFixed(1)}`).join('');
  const area = (pts: SeriesPoint[]) =>
    pts.length ? `${path(pts)}L${x(pts.at(-1)!.t).toFixed(1)},${y(0)}L${x(pts[0]!.t).toFixed(1)},${y(0)}Z` : '';
  // Overlapping fills muddy each other, so only a lone series gets one.
  const single = () => props.series.length === 1;

  const yTicks = createMemo(() => Array.from({ length: Y_TICKS + 1 }, (_, i) => (props.yMax * i) / Y_TICKS));
  const xTicks = createMemo(() => {
    const daily = span() > HOURLY_TICK_MAX_DAYS * DAY_MS;
    const step = daily ? DAY_MS : HOURLY_TICK_STEP_MS;
    const start = new Date(props.from);
    if (daily) start.setHours(24, 0, 0, 0);
    else start.setHours(Math.ceil(start.getHours() / 6) * 6, 0, 0, 0);
    const out: { t: number; label: string }[] = [];
    for (let t = start.getTime(); t <= props.to; t += step) {
      const d = new Date(t);
      out.push({ t, label: daily ? d.toLocaleDateString(undefined, { weekday: 'short' }) : d.toLocaleTimeString(undefined, { hour: 'numeric' }) });
    }
    return out;
  });
  const gradientId = `qc-${createUniqueId()}`;

  /** Each series' value at the hovered time: history up to now, projection after. */
  const readout = createMemo(() => {
    const t = hoverT();
    if (t === null) return [];
    return props.series.flatMap((s) => {
      const v = valueAt(t <= props.now ? s.past : (s.future ?? []), t);
      return v === null ? [] : [{ s, v }];
    });
  });

  const hoverAt = (t: number, clientX: number, clientY: number) => {
    setHoverT(Math.min(props.to, Math.max(props.from, t)));
    setPointer({ x: clientX, y: clientY });
  };
  const onMove = (e: PointerEvent) => {
    const rect = host.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (px < PAD.left || px > width() - PAD.right) return setHoverT(null);
    hoverAt(tAt(px), e.clientX, e.clientY);
  };
  const onKey = (e: KeyboardEvent) => {
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const t = (hoverT() ?? props.now) + (dir * span()) / KEY_STEPS;
    const rect = host.getBoundingClientRect();
    hoverAt(t, rect.left + x(t), rect.top + PAD.top);
  };

  return (
    <div ref={host} class="quota-chart" onPointerMove={onMove} onPointerLeave={() => setHoverT(null)}>
      <svg class="chart" width={width()} height={height()} role="img" aria-label={props.ariaLabel} tabindex="0" onKeyDown={onKey} onBlur={() => setHoverT(null)}>
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stop-color={props.series[0]?.color} stop-opacity="0.28" />
            <stop offset="1" stop-color={props.series[0]?.color} stop-opacity="0" />
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
        <For each={xTicks()}>{(tick) => <text x={x(tick.t)} y={height() - 6} text-anchor="middle">{tick.label}</text>}</For>
        <For each={props.series}>
          {(s) => (
            <>
              <Show when={single()}><path d={area(s.past)} fill={`url(#${gradientId})`} /></Show>
              <path d={path(s.past)} fill="none" stroke={s.color} stroke-width="2" stroke-linejoin="round" />
              <Show when={s.future?.length}>
                <path d={path(s.future!)} fill="none" stroke={s.color} stroke-width="1.6" stroke-dasharray="5 4" opacity="0.75" />
              </Show>
            </>
          )}
        </For>
        <Show when={props.now >= props.from && props.now <= props.to}>
          <line x1={x(props.now)} x2={x(props.now)} y1={PAD.top} y2={y(0)} stroke="var(--color-text-muted)" stroke-dasharray="3 3" />
          <text x={x(props.now)} y={PAD.top + 10} text-anchor="middle" style={{ fill: 'var(--color-text-secondary)' }}>Now</text>
        </Show>
        <Show when={hoverT() !== null}>
          <line x1={x(hoverT()!)} x2={x(hoverT()!)} y1={PAD.top} y2={y(0)} stroke="var(--color-text-secondary)" stroke-width="1" />
          <For each={readout()}>
            {(r) => <circle cx={x(hoverT()!)} cy={y(r.v)} r={HOVER_DOT_RADIUS} fill={r.s.color} stroke="var(--color-surface)" stroke-width="2" />}
          </For>
        </Show>
      </svg>
      <Show when={hoverT() !== null && readout().length > 0}>
        <ChartTip
          title={`${dayTime(hoverT()!)}${hoverT()! > props.now ? ' · projected' : ''}`}
          rows={readout().map((r) => ({ label: r.s.label, value: props.yLabel(r.v), color: r.s.color }))}
          x={pointer().x}
          y={pointer().y}
        />
      </Show>
    </div>
  );
}
