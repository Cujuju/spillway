import { Sunrise, Sunset } from 'lucide-solid';
import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import type { ActivityBucket } from '@shared/types';
import { hourOfDay } from '../lib/activityHeat';
import { calendarDays, spanDays, type Span } from '../lib/activityRange';
import { hourLabel, metricValue, type Metric, type Summary } from '../lib/activityStats';
import { rhythmScene } from '../lib/rhythmScene';
import { dayWeight, HORIZON_Y, moonPhase, skyGeometry } from '../lib/sky';
import { createZipCoordinates, fallbackCoordinates, solarTimes } from '../lib/solarTimes';
import { ChartTip, HoverTip, type TipRow } from './ChartTip';
import { RhythmSkyBack, RhythmSkyFront } from './RhythmSky';
import '../styles/rhythm.css';

const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
/** Tallest bar as a share of the sky above the horizon, leaving room for the peak label. */
const BAR_MAX = 0.8;
/** Axis keeps midnight and noon, dropping either when a sunrise or sunset label is this close. */
const AXIS_HOURS = [0, 12, 24];
const AXIS_GAP_HOURS = 2;
const AXIS_ICON_PX = 12;
const pct = (share: number) => `${share * 100}%`;
const timeLabel = (hour: number) => new Date(2000, 0, 1, 0, Math.round(hour * MINUTES_PER_HOUR)).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export function ActivityRhythm(props: {
  rows: ActivityBucket[];
  zipCode?: string;
  span: Span;
  now: number;
  metric: Metric;
  format: (s: Summary) => string;
  tooltip: (s: Summary) => TipRow[];
}) {
  let skyEl!: HTMLDivElement;
  const [size, setSize] = createSignal({ width: 0, height: 0 });
  onMount(() => {
    const ro = new ResizeObserver(([e]) => { if (e) setSize({ width: e.contentRect.width, height: e.contentRect.height }); });
    ro.observe(skyEl);
    onCleanup(() => ro.disconnect());
  });
  const zipCoordinates = createZipCoordinates(() => props.zipCode ?? '');
  const coordinates = () => zipCoordinates() ?? fallbackCoordinates(props.now);
  const times = createMemo(() => solarTimes(new Date(props.now), coordinates()));
  const polar = () => times().sunset - times().sunrise === HOURS_PER_DAY || times().sunset === times().sunrise;
  const sky = createMemo(() => skyGeometry(times()));
  const scene = createMemo(() => (size().width > 0 && size().height > 0 ? rhythmScene(size().width, size().height, props.now, coordinates()) : null));
  const stats = createMemo(() => hourOfDay(props.rows, props.span, props.metric));
  const share = (h: number) => (stats().max > 0 ? metricValue(stats().hours[h]!, props.metric) / stats().max : 0);
  const currentHour = () => new Date(props.now).getHours();
  const upBody = () => { const s = scene(); return s?.sun.up ? 'sun' : s?.moon.up ? 'moon' : null; };
  const sunEvents = () => (polar() ? [] : [times().sunrise, times().sunset]);
  const axisHours = () => AXIS_HOURS.filter((h) => sunEvents().every((e) => Math.abs(e - h) >= AXIS_GAP_HOURS));
  const days = () => spanDays(props.span) <= 1 ? 1 : calendarDays(props.span);
  const [tip, setTip] = createSignal<{ cell: HTMLElement; hour: number } | null>(null);
  const show = (e: Event, hour: number) => setTip({ cell: e.currentTarget as HTMLElement, hour });

  return (
    <div class="rhythm">
      <div ref={skyEl} class="rhythm-sky" classList={{ 'polar-day': times().sunset - times().sunrise === HOURS_PER_DAY, 'polar-night': times().sunset === times().sunrise }}
        data-up={upBody() ?? 'none'} style={{ '--sky-gradient': sky().gradient, '--horizon': pct(HORIZON_Y) }} onPointerLeave={() => setTip(null)}>
        <div class="rhythm-depth" aria-hidden="true" />
        <div class="rhythm-water" aria-hidden="true">
          <div class="night" />
          <div class="day" style={{ '-webkit-mask-image': sky().daylightMask, 'mask-image': sky().daylightMask }} />
        </div>
        <For each={sky().stars}>{(s) => (
          <span class={`rhythm-star size-${s.size}`} classList={{ twinkle: s.twinkle }} aria-hidden="true"
            style={{ left: pct(s.x), top: pct(s.y), '--star-fade': s.fade, 'animation-delay': `${s.delay}s` }} />
        )}</For>
        <Show when={scene()}>{(s) => <RhythmSkyBack scene={s()} />}</Show>
        <div class="rhythm-bars" role="list" aria-label="Activity by hour of day">
          <For each={stats().hours}>{(s, h) => (
            <div
              class="rhythm-bar"
              classList={{ peak: stats().peak === h(), empty: share(h()) === 0, current: currentHour() === h() }}
              role="listitem"
              tabindex="0"
              aria-label={`${hourLabel(h())}: ${props.format(s)}`}
              style={{ height: pct(share(h()) * BAR_MAX), '--day': pct(dayWeight(h() + 0.5, times())) }}
              onPointerEnter={(e) => show(e, h())}
              onFocus={(e) => show(e, h())}
              onBlur={() => setTip(null)}
            >
              <Show when={stats().peak === h()}><span class="rhythm-peak-label" aria-hidden="true">{props.format(s)}</span></Show>
            </div>
          )}</For>
        </div>
        <Show when={scene()}>{(s) => (
          <RhythmSkyFront scene={s()} phase={moonPhase(props.now)}
            sunEvents={sunEvents().map((h) => (h / HOURS_PER_DAY) * s().width)}
            currentBarTop={s().horizon * (1 - share(currentHour()) * BAR_MAX)} />
        )}</Show>
      </div>
      <div class="rhythm-axis" aria-hidden="true">
        <For each={axisHours()}>{(h) => <span class={h === 0 ? 'start' : h === HOURS_PER_DAY ? 'end' : ''} style={{ left: pct(h / HOURS_PER_DAY) }}>{hourLabel(h % HOURS_PER_DAY)}</span>}</For>
        <For each={sunEvents()}>{(h, i) => (
          <span class="sun-event" style={{ left: pct(h / HOURS_PER_DAY) }}>
            {i() === 0 ? <Sunrise size={AXIS_ICON_PX} /> : <Sunset size={AXIS_ICON_PX} />}{timeLabel(h)}
          </span>
        )}</For>
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
