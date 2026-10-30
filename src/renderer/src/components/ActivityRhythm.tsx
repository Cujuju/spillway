import { Sun } from 'lucide-solid';
import { createMemo, createSignal, For, Show } from 'solid-js';
import type { ActivityBucket } from '@shared/types';
import { hourOfDay } from '../lib/activityHeat';
import { spanDays, type Span } from '../lib/activityRange';
import { hourLabel, metricValue, type Metric, type Summary } from '../lib/activityStats';
import { moonPath, moonPhase, phaseName, skyBody, sunArc, SUNRISE_HOUR, SUNSET_HOUR, TWILIGHT_HOURS } from '../lib/sky';
import { ChartTip, type TipRow } from './ChartTip';
import '../styles/rhythm.css';

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
const STAR_COUNT = 22;
/** Fractional part of the golden ratio: successive multiples scatter evenly. */
const GOLDEN_FRACTION = 0.618034;
/** Stars stay in the upper part of the sky above the horizon. */
const STAR_BAND = 0.9;
/** Every third star is fainter. */
const DIM_EVERY = 3;
const pct = (share: number) => `${share * 100}%`;
const skyY = (height: number) => HORIZON_Y - height * (HORIZON_Y - ARC_TOP_Y);

/** Fixed, evenly scattered stars in the night parts of the sky (golden-ratio sequence, so no randomness per render). */
const STARS = Array.from({ length: STAR_COUNT }, (_, i) => {
  const nightHours = HOURS_PER_DAY - (SUNSET_HOUR - SUNRISE_HOUR) - 2 * TWILIGHT_HOURS;
  const h = ((i * GOLDEN_FRACTION) % 1) * nightHours;
  const hour = h < SUNRISE_HOUR - TWILIGHT_HOURS ? h : h + (SUNSET_HOUR - SUNRISE_HOUR) + 2 * TWILIGHT_HOURS;
  return { x: hour / HOURS_PER_DAY, y: ((i * GOLDEN_FRACTION * GOLDEN_FRACTION) % 1) * HORIZON_Y * STAR_BAND, dim: i % DIM_EVERY === 0 };
});

export function ActivityRhythm(props: {
  rows: ActivityBucket[];
  span: Span;
  now: number;
  metric: Metric;
  format: (s: Summary) => string;
  tooltip: (s: Summary) => TipRow[];
}) {
  const stats = createMemo(() => hourOfDay(props.rows, props.span, props.metric));
  const clock = () => { const d = new Date(props.now); return d.getHours() + d.getMinutes() / MINUTES_PER_HOUR; };
  const body = createMemo(() => skyBody(clock()));
  const phase = createMemo(() => moonPhase(props.now));
  const days = () => Math.max(1, Math.round(spanDays(props.span)));
  const [tip, setTip] = createSignal<{ cell: HTMLElement; hour: number } | null>(null);
  const show = (e: Event, hour: number) => setTip({ cell: e.currentTarget as HTMLElement, hour });
  const arc = sunArc(ARC_STEPS).map((p) => `${p.x},${skyY(p.height)}`).join(' ');

  return (
    <div class="rhythm">
      <div class="rhythm-sky" style={{
        '--sunrise': pct(SUNRISE_HOUR / HOURS_PER_DAY), '--sunset': pct(SUNSET_HOUR / HOURS_PER_DAY), '--twilight': pct(TWILIGHT_HOURS / HOURS_PER_DAY),
      }} onPointerLeave={() => setTip(null)}>
        <For each={STARS}>{(s) => <span class="rhythm-star" classList={{ dim: s.dim }} style={{ left: pct(s.x), top: pct(s.y) }} aria-hidden="true" />}</For>
        <svg class="rhythm-arc" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
          <line x1="0" y1={HORIZON_Y} x2="1" y2={HORIZON_Y} />
          <polyline points={arc} />
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
          <span title="Older days kept only as daily totals have no hour detail">{stats().undetailedDays}d without hours</span>
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
