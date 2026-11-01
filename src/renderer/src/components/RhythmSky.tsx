import { createUniqueId, For, Show } from 'solid-js';
import type { RhythmScene } from '../lib/rhythmScene';
import { moonPath, phaseName } from '../lib/sky';

const SUN_GLOW_PX = 40;
const MOON_GLOW_PX = 30;
const SUN_CORE_PX = 3.6;
const SUN_RAY_FROM_PX = 5.8;
const SUN_RAY_TO_PX = 7.8;
const SUN_RAYS = 8;
const MOON_RADIUS_PX = 6.5;
/** Gap between a body and the top of its tick. */
const TICK_CLEARANCE_PX = 10;
const TICK_BAR_GAP_PX = 3;
/** Glints on the water under the body that is up: offset below the horizon and half-widths. */
const GLINTS = [{ dy: 6, rx: 12, ry: 1.6 }, { dy: 13, rx: 7, ry: 1.1 }];
const BODIES = ['moon', 'sun'] as const;
/** Each path is drawn four times: travelled or ahead of now, above or below the horizon. */
const SEGMENTS = [['past', 'up'], ['next', 'up'], ['past', 'down'], ['next', 'down']] as const;

const upBody = (s: RhythmScene) => (s.sun.up ? 'sun' : s.moon.up ? 'moon' : null);

/** Behind the bars: glows, the full sun and moon paths, and glints on the water. */
export function RhythmSkyBack(props: { scene: RhythmScene }) {
  const id = createUniqueId();
  const s = () => props.scene;
  const up = () => upBody(s());
  return (
    <svg class="rhythm-layer" viewBox={`0 0 ${s().width} ${s().height}`} aria-hidden="true">
      <defs>
        <clipPath id={`${id}-up`}><rect width={s().width} height={s().horizon} /></clipPath>
        <clipPath id={`${id}-down`}><rect y={s().horizon} width={s().width} height={s().height - s().horizon} /></clipPath>
        <clipPath id={`${id}-past`}><rect width={s().x} height={s().height} /></clipPath>
        <clipPath id={`${id}-next`}><rect x={s().x} width={Math.max(0, s().width - s().x)} height={s().height} /></clipPath>
        <For each={BODIES}>{(body) => (
          <radialGradient id={`${id}-${body}`} class={`rhythm-glow ${body}`}><stop offset="0" /><stop offset="0.4" /><stop offset="1" /></radialGradient>
        )}</For>
      </defs>
      <For each={BODIES}>{(body) => (
        <Show when={s()[body].up}>
          <circle cx={s().x} cy={s()[body].y} r={body === 'sun' ? SUN_GLOW_PX : MOON_GLOW_PX} fill={`url(#${id}-${body})`} />
        </Show>
      )}</For>
      <For each={BODIES}>{(body) => (
        <For each={SEGMENTS}>{([time, side]) => (
          <g clip-path={`url(#${id}-${time})`}>
            <path class={`rhythm-path ${body} ${time} ${side}`} d={s()[body].path} clip-path={`url(#${id}-${side})`} />
          </g>
        )}</For>
      )}</For>
      <Show when={up()}>{(body) => (
        <For each={GLINTS}>{(g) => <ellipse class={`rhythm-glint ${body()}`} cx={s().x} cy={s().horizon + g.dy} rx={g.rx} ry={g.ry} />}</For>
      )}</Show>
    </svg>
  );
}

/** In front of the bars: the horizon, rise and set marks, the now tick, and the sun and moon. */
export function RhythmSkyFront(props: { scene: RhythmScene; sunEvents: number[]; phase: number; currentBarTop: number }) {
  const s = () => props.scene;
  const up = () => upBody(s());
  const tickTop = () => { const body = up(); return body ? s()[body].y + TICK_CLEARANCE_PX : 0; };
  const tickBottom = () => props.currentBarTop - TICK_BAR_GAP_PX;
  const rays = Array.from({ length: SUN_RAYS }, (_, i) => (i * 2 * Math.PI) / SUN_RAYS);
  return (
    <svg class="rhythm-layer" viewBox={`0 0 ${s().width} ${s().height}`}>
      <line class="rhythm-horizon" x1="0" x2={s().width} y1={s().horizon} y2={s().horizon} aria-hidden="true" />
      <Show when={up() && tickTop() < tickBottom()}>
        <line class={`rhythm-tick ${up()}`} x1={s().x} x2={s().x} y1={tickTop()} y2={tickBottom()} aria-hidden="true" />
      </Show>
      <For each={props.sunEvents}>{(x) => <circle class="rhythm-event sun" cx={x} cy={s().horizon} r="2.2" aria-hidden="true" />}</For>
      <For each={s().moon.crossings}>{(c) => <circle class="rhythm-event moon" cx={c.x} cy={s().horizon} r="2" aria-hidden="true" />}</For>
      <g class="rhythm-sun" classList={{ below: !s().sun.up }} aria-hidden="true">
        <circle cx={s().x} cy={s().sun.y} r={SUN_CORE_PX} />
        <For each={rays}>{(a) => (
          <line x1={s().x + SUN_RAY_FROM_PX * Math.cos(a)} y1={s().sun.y + SUN_RAY_FROM_PX * Math.sin(a)}
            x2={s().x + SUN_RAY_TO_PX * Math.cos(a)} y2={s().sun.y + SUN_RAY_TO_PX * Math.sin(a)} />
        )}</For>
      </g>
      <g class="rhythm-moon" classList={{ below: !s().moon.up }} transform={`translate(${s().x} ${s().moon.y})`} role="img" aria-label={phaseName(props.phase)}>
        <title>{phaseName(props.phase)}</title>
        <circle class="dark" r={MOON_RADIUS_PX} />
        <path class="lit" d={moonPath(props.phase, MOON_RADIUS_PX)} />
      </g>
    </svg>
  );
}
