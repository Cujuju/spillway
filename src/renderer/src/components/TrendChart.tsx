import { createMemo, createSignal, createUniqueId, For, onCleanup, onMount, Show } from 'solid-js';
import { ChartTip, type TipRow } from './ChartTip';

/** Left pad fits a 5-character axis label ("$37.5", "100%"). */
const PAD = { left: 44, right: 8, top: 10, bottom: 22 };
const DEFAULT_Y_TICKS = 4;
/** A 7-day range labels every day; ~60px per label fits the narrowest window's ~550px plot. */
const X_LABELS = 8;
/** Fraction of each slot a bar fills; the rest is the gap between bars. */
const BAR_FILL = 0.72;
/** Bars round their top (data end) by this much, never wider than half the bar. */
const BAR_RADIUS = 4;
const POINT_RADIUS = 2.5;
/** Smallest height a fill-height chart draws: x labels plus two gridlines. */
export const TREND_MIN_HEIGHT_PX = 80;
/** Closest two y gridlines sit: an 11px axis label plus room, so a short chart drops gridlines instead of overlapping labels. */
const MIN_Y_TICK_GAP_PX = 20;

export interface TrendPoint {
  start: number;
  /** null leaves a gap (no data for the bucket). */
  value: number | null;
}

export interface TrendChartProps {
  points: TrendPoint[];
  kind: 'bar' | 'line';
  /** Fixed height; omitted, the chart fills its container's height. */
  height?: number;
  ariaLabel: string;
  yLabel: (v: number) => string;
  xLabel: (t: number) => string;
  /** Fixed scale top (e.g. 1 for a rate); otherwise a round number above the largest value. */
  yMax?: number;
  /** Gridlines above the baseline. */
  yTicks?: number;
  tooltip: (index: number) => { title: string; rows: TipRow[] };
}

/** 1, 2, 2.5 or 5 times a power of ten, at least `v`. */
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 2.5, 5, 10].find((m) => m * p >= v) ?? 10) * p;
}

/** Bar or line over time with a per-bucket hover readout (pointer and arrow keys). */
export function TrendChart(props: TrendChartProps) {
  const descriptionId = createUniqueId();
  let host!: HTMLDivElement;
  const [width, setWidth] = createSignal(800);
  const [fillHeight, setFillHeight] = createSignal(TREND_MIN_HEIGHT_PX);
  const height = () => props.height ?? fillHeight();
  const [hover, setHover] = createSignal<number | null>(null);
  const [pointer, setPointer] = createSignal({ x: 0, y: 0 });
  onMount(() => {
    const ro = new ResizeObserver(([e]) => {
      if (!e) return;
      setWidth(Math.max(200, e.contentRect.width));
      setFillHeight(Math.max(TREND_MIN_HEIGHT_PX, e.contentRect.height));
    });
    ro.observe(host);
    onCleanup(() => ro.disconnect());
  });

  const plotW = () => width() - PAD.left - PAD.right;
  const plotH = () => height() - PAD.top - PAD.bottom;
  const slot = () => plotW() / Math.max(1, props.points.length);
  const yMax = createMemo(() => props.yMax ?? niceCeil(Math.max(0, ...props.points.map((p) => p.value ?? 0))));
  const x = (i: number) => PAD.left + slot() * (i + 0.5);
  const y = (v: number) => PAD.top + plotH() - (Math.min(v, yMax()) / yMax()) * plotH();
  const baseline = () => PAD.top + plotH();

  const barPath = (i: number, v: number) => {
    const w = Math.max(1, slot() * BAR_FILL);
    const left = x(i) - w / 2;
    const top = y(v);
    const r = Math.min(BAR_RADIUS, w / 2, baseline() - top);
    return `M${left},${baseline()}V${top + r}Q${left},${top} ${left + r},${top}H${left + w - r}Q${left + w},${top} ${left + w},${top + r}V${baseline()}Z`;
  };
  const linePath = createMemo(() => {
    let d = '';
    let open = false;
    props.points.forEach((p, i) => {
      if (p.value === null) return void (open = false);
      d += `${open ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`;
      open = true;
    });
    return d;
  });
  // Label where the text changes (a new day or hour), so labels sit on boundaries; then thin to fit.
  const xTicks = createMemo(() => {
    const labels = props.points.map((p) => props.xLabel(p.start));
    const changes = labels.flatMap((label, i) => (i > 0 && label !== labels[i - 1] ? [{ i, label }] : []));
    const step = Math.max(1, Math.ceil(changes.length / X_LABELS));
    return changes.filter((_, k) => k % step === 0);
  });
  const yTicks = createMemo(() => {
    const count = Math.max(1, Math.min(props.yTicks ?? DEFAULT_Y_TICKS, Math.floor(plotH() / MIN_Y_TICK_GAP_PX)));
    const max = yMax();
    return Array.from({ length: count + 1 }, (_, i) => (max * i) / count);
  });

  const pick = (e: PointerEvent) => {
    const rect = host.getBoundingClientRect();
    const px = e.clientX - rect.left;
    setPointer({ x: e.clientX, y: e.clientY });
    const i = Math.floor((px - PAD.left) / slot());
    setHover(i >= 0 && i < props.points.length ? i : null);
  };
  const onKey = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = Math.min(props.points.length - 1, Math.max(0, (hover() ?? props.points.length - 1) + step));
    setHover(i);
    const rect = host.getBoundingClientRect();
    setPointer({ x: rect.left + x(i), y: rect.top + PAD.top });
  };

  return (
    <div ref={host} class="trend" classList={{ fill: props.height === undefined }} onPointerMove={pick} onPointerLeave={() => setHover(null)}>
      <svg class="chart" style={{ height: `${height()}px` }} width={width()} height={height()} role="img" aria-label={props.ariaLabel} aria-describedby={descriptionId}
        tabindex="0" onKeyDown={onKey} onBlur={() => setHover(null)}>
        <desc id={descriptionId}>
          {props.points.map((p, i) => `${props.tooltip(i).title}: ${p.value === null ? 'No data' : props.yLabel(p.value)}`).join('; ')}
        </desc>
        <For each={yTicks()}>
          {(v) => (
            <>
              <line x1={PAD.left} x2={width() - PAD.right} y1={y(v)} y2={y(v)} stroke="var(--color-border)" stroke-dasharray={v ? '2 4' : undefined} />
              <text x={PAD.left - 8} y={y(v) + 4} text-anchor="end">{props.yLabel(v)}</text>
            </>
          )}
        </For>
        <For each={xTicks()}>{(t) => <text x={x(t.i)} y={height() - 6} text-anchor="middle">{t.label}</text>}</For>
        <Show when={props.kind === 'bar'} fallback={
          <>
            <path d={linePath()} fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linejoin="round" />
            {/* Dots keep a value visible when gaps on both sides leave it no line. */}
            <For each={props.points}>{(p, i) => <Show when={p.value !== null}><circle cx={x(i())} cy={y(p.value!)} r={POINT_RADIUS} fill="var(--color-accent)" /></Show>}</For>
          </>
        }>
          <For each={props.points}>
            {(p, i) => (
              <Show when={p.value}>
                {(v) => <path d={barPath(i(), v())} fill="var(--color-accent)" opacity={hover() === null || hover() === i() ? 1 : 0.55} />}
              </Show>
            )}
          </For>
        </Show>
        <Show when={hover() !== null}>
          <line x1={x(hover()!)} x2={x(hover()!)} y1={PAD.top} y2={baseline()} stroke="var(--color-text-muted)" stroke-dasharray="3 3" />
          <Show when={props.kind === 'line' ? props.points[hover()!]?.value : null}>
            {(v) => <circle cx={x(hover()!)} cy={y(v())} r="4" fill="var(--color-accent)" stroke="var(--color-surface)" stroke-width="2" />}
          </Show>
        </Show>
      </svg>
      <Show when={hover() !== null}>
        <ChartTip {...props.tooltip(hover()!)} x={pointer().x} y={pointer().y} />
      </Show>
    </div>
  );
}
