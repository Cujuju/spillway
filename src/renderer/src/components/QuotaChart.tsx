import { createEffect, createMemo, createSignal, createUniqueId, For, on, onCleanup, onMount, Show } from 'solid-js';
import { panRange, timeTicks, wheelFactor, zoomRange, type TimeRange } from '../lib/chartZoom';
import type { SeriesPoint } from '../lib/poolHistory';
import { valueAt } from '../lib/poolWindows';
import { dayTime } from '../lib/format';
import { ChartTip } from './ChartTip';

const PAD = { left: 48, right: 12, top: 12, bottom: 26 };
const Y_TICKS = 4;
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
  /** Lines may reach past `from`; the wheel widens the view as far back as they go. */
  series: QuotaSeries[];
  /** Default view; `to` is also the furthest the view reaches ahead. */
  from: number;
  to: number;
  now: number;
  /** Y-axis top for the largest value in view. */
  yMax: (peak: number) => number;
  yLabel: (v: number) => string;
  ariaLabel: string;
}

/**
 * Lines over time: history, dashed projection, "Now" marker, crosshair readout. Fills its host's height.
 * Wheel zooms around the pointer (up widens); drag or Shift+wheel pans; double-click resets.
 */
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

  // Zoom held as offsets from now, so a zoomed view follows the clock like the default one.
  const [zoom, setZoom] = createSignal<{ back: number; ahead: number } | null>(null);
  const defaultOffsets = createMemo(() => `${props.now - props.from}:${props.to - props.now}`);
  // A new lookback or forecast length shows its whole default span.
  createEffect(on(defaultOffsets, () => setZoom(null), { defer: true }));
  const bounds = createMemo((): TimeRange => ({
    from: Math.min(props.from, ...props.series.map((s) => s.past[0]?.t ?? props.from)),
    to: props.to,
  }));
  const view = createMemo((): TimeRange => {
    const z = zoom();
    if (!z) return { from: props.from, to: props.to };
    return { from: Math.max(bounds().from, props.now - z.back), to: Math.min(bounds().to, props.now + z.ahead) };
  });

  const plotW = () => width() - PAD.left - PAD.right;
  const plotH = () => height() - PAD.top - PAD.bottom;
  const span = () => Math.max(1, view().to - view().from);
  const x = (t: number) => PAD.left + ((t - view().from) / span()) * plotW();
  const tAt = (px: number) => view().from + ((px - PAD.left) / plotW()) * span();
  const yMax = createMemo(() => {
    const { from, to } = view();
    let peak = 0;
    for (const s of props.series) for (const p of [...s.past, ...(s.future ?? [])]) if (p.t >= from && p.t <= to) peak = Math.max(peak, p.remaining);
    return Math.max(1, props.yMax(peak));
  });
  const y = (v: number) => PAD.top + plotH() - (Math.min(yMax(), Math.max(0, v)) / yMax()) * plotH();
  const path = (pts: SeriesPoint[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.remaining).toFixed(1)}`).join('');
  const area = (pts: SeriesPoint[]) =>
    pts.length ? `${path(pts)}L${x(pts.at(-1)!.t).toFixed(1)},${y(0)}L${x(pts[0]!.t).toFixed(1)},${y(0)}Z` : '';
  // Overlapping fills muddy each other, so only a lone series gets one.
  const single = () => props.series.length === 1;

  const yTicks = createMemo(() => {
    const max = yMax();
    return Array.from({ length: Y_TICKS + 1 }, (_, i) => (max * i) / Y_TICKS);
  });
  const xTicks = createMemo(() => timeTicks(view()));
  const gradientId = `qc-${createUniqueId()}`;
  const clipId = `qc-clip-${createUniqueId()}`;

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
    setHoverT(Math.min(view().to, Math.max(view().from, t)));
    setPointer({ x: clientX, y: clientY });
  };
  const setView = (next: TimeRange) => setZoom({ back: props.now - next.from, ahead: next.to - props.now });
  const msPerPx = () => span() / Math.max(1, plotW());
  // Drag pans: the view at pointer-down plus the pointer's travel, so the grabbed time follows the pointer.
  const [drag, setDrag] = createSignal<{ x: number; view: TimeRange } | null>(null);
  const canPan = () => view().from > bounds().from || view().to < bounds().to;
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || !canPan()) return;
    host.setPointerCapture(e.pointerId);
    setDrag({ x: e.clientX, view: view() });
    setHoverT(null);
  };
  const onUp = (e: PointerEvent) => {
    if (!drag()) return;
    host.releasePointerCapture(e.pointerId);
    setDrag(null);
    onMove(e);
  };
  const onMove = (e: MouseEvent) => {
    const d = drag();
    if (d) return setView(panRange(d.view, (d.x - e.clientX) * msPerPx(), bounds()));
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
  // Vertical wheel zooms; horizontal scroll (Shift+wheel, trackpad swipe) pans.
  const onWheel = (e: WheelEvent) => {
    if (!e.deltaY && !e.deltaX) return;
    e.preventDefault();
    const rect = host.getBoundingClientRect();
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) setView(panRange(view(), e.deltaX * msPerPx(), bounds()));
    else setView(zoomRange(view(), tAt(e.clientX - rect.left), wheelFactor(e.deltaY), bounds()));
    onMove(e);
  };

  return (
    <div
      ref={host}
      class="quota-chart"
      classList={{ pannable: canPan(), panning: drag() !== null }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onPointerLeave={() => setHoverT(null)}
      onWheel={onWheel}
      onDblClick={() => setZoom(null)}
    >
      <svg class="chart" width={width()} height={height()} role="img" aria-label={props.ariaLabel} tabindex="0" onKeyDown={onKey} onBlur={() => setHoverT(null)}>
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stop-color={props.series[0]?.color} stop-opacity="0.28" />
            <stop offset="1" stop-color={props.series[0]?.color} stop-opacity="0" />
          </linearGradient>
          <clipPath id={clipId}>
            <rect x={PAD.left} y={0} width={Math.max(0, plotW())} height={height()} />
          </clipPath>
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
        <g clip-path={`url(#${clipId})`}>
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
        </g>
        <Show when={props.now >= view().from && props.now <= view().to}>
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
