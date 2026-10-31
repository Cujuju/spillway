import { Sun } from 'lucide-solid';
import { createMemo, createResource, createSignal, For, Show } from 'solid-js';
import type { ActivityBucket } from '@shared/types';
import { hourOfDay } from '../lib/activityHeat';
import { calendarDays, spanDays, type Span } from '../lib/activityRange';
import { hourLabel, metricValue, type Metric, type Summary } from '../lib/activityStats';
import { moonPath, moonPhase, phaseName, skyBody, sunArc, skyGeometry } from '../lib/sky';
import { ChartTip, HoverTip, type TipRow } from './ChartTip';
import '../styles/rhythm.css';
import { zipCoordinates } from '../lib/zipCoordinates';
import { FALLBACK_SUN_TIMES, solarTimes } from '../lib/solarTimes';

const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
/** Horizon and arc top as shares of the sky's height, from the top. */
const HORIZON_Y = 0.6;
const ARC_TOP_Y = 0.12;
/** Tallest bar as a share of the sky's height, leaving room above it. */
const BAR_MAX = 0.9;
const ARC_STEPS = 48;
const SUN_PX = 16;
const MOON_RADIUS_PX = 6;
/** Axis labels every 6 hours, closing on midnight. */
const AXIS_HOURS = [0, 6, 12, 18, 24];
const pct = (share: number) => `${share * 100}%`;
const skyY = (height: number) => HORIZON_Y - height * (HORIZON_Y - ARC_TOP_Y);

export function ActivityRhythm(props: {
  rows: ActivityBucket[];
  zipCode?: string;
  span: Span;
  now: number;
  metric: Metric;
  format: (s: Summary) => string;
  tooltip: (s: Summary) => TipRow[];
}) {
  const [coordinates] = createResource(() => props.zipCode || null, (zip) => zipCoordinates(zip).catch(() => null));
  const times = createMemo(() => {
    const point = coordinates();
    return point && props.zipCode ? solarTimes(new Date(props.now), point) : FALLBACK_SUN_TIMES;
  });
  const sky = createMemo(() => skyGeometry(times()));
  const stats = createMemo(() => hourOfDay(props.rows, props.span, props.metric));
  const clock = () => { const d = new Date(props.now); return d.getHours() + d.getMinutes() / MINUTES_PER_HOUR; };
  const body = createMemo(() => skyBody(clock(), times()));
  const phase = createMemo(() => moonPhase(props.now));
  const days = () => spanDays(props.span) <= 1 ? 1 : calendarDays(props.span);
  const [tip, setTip] = createSignal<{ cell: HTMLElement; hour: number } | null>(null);
  const show = (e: Event, hour: number) => setTip({ cell: e.currentTarget as HTMLElement, hour });
  const arc = (shift = 0) => sunArc(ARC_STEPS, times()).map((p) => `${p.x + shift},${skyY(p.height)}`).join(' ');

  return (
    <div class="rhythm">
      <div class="rhythm-sky" classList={{ 'polar-day': times().sunset - times().sunrise === HOURS_PER_DAY, 'polar-night': times().sunset === times().sunrise }} style={{
        '--sky-gradient': sky().gradient,
      }} onPointerLeave={() => setTip(null)}>
        <For each={sky().stars}>{(s) => <span class="rhythm-star" classList={{ dim: s.dim }} style={{ left: pct(s.x), top: pct(s.y) }} aria-hidden="true" />}</For>
        <svg class="rhythm-arc" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
          <line x1="0" y1={HORIZON_Y} x2="1" y2={HORIZON_Y} />
          <polyline points={arc()} />
          <Show when={times().sunset < times().sunrise}><polyline points={arc(-1)} /></Show>
        </svg>
        <div class="rhythm-bars" role="list" aria-label="Activity by hour of day">
          <For each={stats().hours}>{(s, h) => (
            <div
              class="rhythm-bar"
              classList={{ peak: stats().peak === h() }}
              role="listitem"
              tabindex="0"
              aria-label={`${hourLabel(h())}: ${props.format(s)}`}
              style={{ height: pct(stats().max > 0 ? (metricValue(s, props.metric) / stats().max) * BAR_MAX : 0) }}
              onPointerEnter={(e) => show(e, h())}
              onFocus={(e) => show(e, h())}
              onBlur={() => setTip(null)}
            />
          )}</For>
        </div>
        <span class="rhythm-now" style={{ left: pct(clock() / HOURS_PER_DAY) }} aria-hidden="true" />
        <Show when={body().body === 'sun'} fallback={
          <svg class="rhythm-body rhythm-moon" style={{ left: pct(body().x), top: pct(skyY(body().height)) }}
            width={MOON_RADIUS_PX * 2} height={MOON_RADIUS_PX * 2} viewBox={`${-MOON_RADIUS_PX} ${-MOON_RADIUS_PX} ${MOON_RADIUS_PX * 2} ${MOON_RADIUS_PX * 2}`}
            role="img" aria-label={phaseName(phase())}>
            <title>{phaseName(phase())}</title>
            <circle class="dark" r={MOON_RADIUS_PX} />
            <path class="lit" d={moonPath(phase(), MOON_RADIUS_PX)} />
          </svg>
        }>
          <Sun class="rhythm-body rhythm-sun" size={SUN_PX} style={{ left: pct(body().x), top: pct(skyY(body().height)) }} aria-hidden="true" />
        </Show>
      </div>
      <div class="rhythm-axis" aria-hidden="true">
        <For each={AXIS_HOURS}>{(h) => <span>{hourLabel(h % HOURS_PER_DAY)}</span>}</For>
      </div>
      <div class="rhythm-footer">
        <span>Busiest hour: <strong>{stats().peak === null ? '—' : hourLabel(stats().peak!)}</strong></span>
        <Show when={stats().undetailedDays > 0}>
          <HoverTip title="Missing hourly detail" rows={[{ label: 'Days', value: stats().undetailedDays.toLocaleString() }, { label: 'Reason', value: 'Older days keep daily totals only' }]}><span>{stats().undetailedDays}d without hours</span></HoverTip>
        </Show>
        <span>{days()}d · {props.format(stats().total)} total</span>
      </div>
      <Show when={tip()}>
        {(t) => <ChartTip title={hourLabel(t().hour)} rows={props.tooltip(stats().hours[t().hour]!)}
          anchor={() => (t().cell.isConnected ? t().cell.getBoundingClientRect() : null)} />}
      </Show>
    </div>
  );
}
