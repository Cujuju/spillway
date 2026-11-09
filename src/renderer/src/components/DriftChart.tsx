import { createMemo, createSignal, createUniqueId, For, onCleanup, onMount, Show } from 'solid-js';
import { ChartTip, type TipRow } from './ChartTip';
import { niceCeil } from './TrendChart';

/** Left pad fits a 6-character axis label ("12.5K", "100.0%"). */
const PAD = { left: 48, right: 10, top: 14, bottom: 22 };
/** Quarters of a 1/2/2.5/5 scale top land on round labels (500, 1K, 1.5K, 2K). */
const Y_TICKS = 4;
/** ~56px per day label keeps a 30-day axis readable at the narrowest card width. */
const X_LABEL_PX = 56;
const POINT_RADIUS = 2.5;
const FLAG_RADIUS = 4.5;
/** Marker diamonds sit in the top padding, clear of the plot. */
const MARKER_SIZE = 4;
const MIN_WIDTH_PX = 200;

export interface DriftLine { label: string; color: string; values: (number | null)[] }
export interface DriftBand { low: (number | null)[]; high: (number | null)[]; baseline: (number | null)[] }
export interface DriftMarker { index: number; kind: 'client-version' | 'settings' }

export interface DriftChartProps {
  /** Local days, YYYY-MM-DD, one per slot. */
  days: string[];
  lines: DriftLine[];
  /** Normal range of the first line. */
  band?: DriftBand;
  flags?: ('up' | 'down' | null)[];
  markers?: DriftMarker[];
  height: number;
  yMax?: number;
  yLabel: (v: number) => string;
  ariaLabel: string;
  tooltip: (index: number) => { title: string; rows: TipRow[] };
}

const shortDay = (day: string) => { const [, m, d] = day.split('-'); return `${Number(m)}/${Number(d)}`; };

/** Polyline segments over runs of non-null values. */
function segments(values: (number | null)[], x: (i: number) => number, y: (v: number) => number): string {
  let d = '';
  let open = false;
  values.forEach((v, i) => {
    if (v === null) return void (open = false);
    d += `${open ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    open = true;
  });
  return d;
}

/** Closed areas between low and high over runs where both are known. */
function bandPath(low: (number | null)[], high: (number | null)[], x: (i: number) => number, y: (v: number) => number): string {
  let d = '';
  let run: number[] = [];
  const flush = () => {
    if (run.length) {
      d += run.map((i, k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(high[i]!).toFixed(1)}`).join('');
      d += [...run].reverse().map((i) => `L${x(i).toFixed(1)},${y(low[i]!).toFixed(1)}`).join('') + 'Z';
    }
    run = [];
  };
  low.forEach((l, i) => (l === null || high[i] === null ? flush() : run.push(i)));
  flush();
  return d;
}

/** Daily lines with a shaded normal range, flagged days and client-change markers; hover or arrow keys read a day. */
export function DriftChart(props: DriftChartProps) {
  const descriptionId = createUniqueId();
  let host!: HTMLDivElement;
  const [width, setWidth] = createSignal(600);
  const [hover, setHover] = createSignal<number | null>(null);
  const [pointer, setPointer] = createSignal({ x: 0, y: 0 });
  onMount(() => {
    const ro = new ResizeObserver(([e]) => e && setWidth(Math.max(MIN_WIDTH_PX, e.contentRect.width)));
    ro.observe(host);
    onCleanup(() => ro.disconnect());
  });

  const count = () => Math.max(1, props.days.length);
  const plotW = () => width() - PAD.left - PAD.right;
  const plotH = () => props.height - PAD.top - PAD.bottom;
  const slot = () => plotW() / count();
  const yMax = createMemo(() => props.yMax ?? niceCeil(Math.max(0, ...props.lines.flatMap((l) => l.values.map((v) => v ?? 0)), ...(props.band?.high ?? []).map((v) => v ?? 0))));
  const x = (i: number) => PAD.left + slot() * (i + 0.5);
  const y = (v: number) => PAD.top + plotH() - (Math.min(Math.max(v, 0), yMax()) / yMax()) * plotH();
  const bottom = () => PAD.top + plotH();
  const yTicks = createMemo(() => {
    const max = yMax();
    return Array.from({ length: Y_TICKS + 1 }, (_, i) => (max * i) / Y_TICKS);
  });
  const xTicks = createMemo(() => {
    const step = Math.max(1, Math.ceil(count() / Math.max(1, Math.floor(plotW() / X_LABEL_PX))));
    // Anchor on the newest day so today always carries a label.
    return props.days.flatMap((day, i) => ((props.days.length - 1 - i) % step === 0 ? [{ i, label: shortDay(day) }] : []));
  });

  const pick = (e: PointerEvent) => {
    const rect = host.getBoundingClientRect();
    setPointer({ x: e.clientX, y: e.clientY });
    const i = Math.floor((e.clientX - rect.left - PAD.left) / slot());
    setHover(i >= 0 && i < props.days.length ? i : null);
  };
  const onKey = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = Math.min(props.days.length - 1, Math.max(0, (hover() ?? props.days.length - 1) + step));
    setHover(i);
    const rect = host.getBoundingClientRect();
    setPointer({ x: rect.left + x(i), y: rect.top + PAD.top });
  };

  return (
    <div ref={host} class="drift-chart" onPointerMove={pick} onPointerLeave={() => setHover(null)}>
      <svg class="chart" width={width()} height={props.height} style={{ height: `${props.height}px` }} role="img" aria-label={props.ariaLabel}
        aria-describedby={descriptionId} tabindex="0" onKeyDown={onKey} onBlur={() => setHover(null)}>
        <desc id={descriptionId}>{props.days.map((_, i) => props.tooltip(i).title + ': ' + props.tooltip(i).rows.map((r) => `${r.label} ${r.value}`).join(', ')).join('; ')}</desc>
        <For each={yTicks()}>
          {(v) => (
            <>
              <line x1={PAD.left} x2={width() - PAD.right} y1={y(v)} y2={y(v)} class="drift-grid-line" classList={{ base: !v }} />
              <text x={PAD.left - 8} y={y(v) + 4} text-anchor="end">{props.yLabel(v)}</text>
            </>
          )}
        </For>
        <For each={xTicks()}>{(t) => <text x={x(t.i)} y={props.height - 6} text-anchor="middle">{t.label}</text>}</For>
        <Show when={props.band}>
          {(b) => (
            <>
              <path class="drift-band" d={bandPath(b().low, b().high, x, y)} />
              <path class="drift-baseline" d={segments(b().baseline, x, y)} />
            </>
          )}
        </Show>
        <For each={props.markers ?? []}>
          {(m) => (
            <g class={`drift-marker ${m.kind}`}>
              <line x1={x(m.index)} x2={x(m.index)} y1={PAD.top} y2={bottom()} />
              <path d={`M${x(m.index)},${PAD.top - MARKER_SIZE * 2}l${MARKER_SIZE},${MARKER_SIZE}l${-MARKER_SIZE},${MARKER_SIZE}l${-MARKER_SIZE},${-MARKER_SIZE}Z`} />
            </g>
          )}
        </For>
        <For each={props.lines}>
          {(line) => (
            <g style={{ '--line': line.color }}>
              <path class="drift-line" d={segments(line.values, x, y)} />
              {/* Dots keep a lone day visible when gaps on both sides leave it no line. */}
              <For each={line.values}>{(v, i) => <Show when={v !== null}><circle class="drift-dot" cx={x(i())} cy={y(v!)} r={POINT_RADIUS} /></Show>}</For>
            </g>
          )}
        </For>
        <For each={props.flags ?? []}>
          {(f, i) => <Show when={f && props.lines[0]?.values[i()] != null}><circle class={`drift-flag ${f}`} cx={x(i())} cy={y(props.lines[0]!.values[i()]!)} r={FLAG_RADIUS} /></Show>}
        </For>
        <Show when={hover() !== null}>
          <line class="drift-cursor" x1={x(hover()!)} x2={x(hover()!)} y1={PAD.top} y2={bottom()} />
        </Show>
      </svg>
      <Show when={hover() !== null}><ChartTip {...props.tooltip(hover()!)} x={pointer().x} y={pointer().y} /></Show>
    </div>
  );
}
