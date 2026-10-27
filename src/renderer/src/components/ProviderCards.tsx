import { Layers, RotateCcw } from 'lucide-solid';
import { For, Show } from 'solid-js';
import { providerLabel, trayLevel } from '@shared/trayValues';
import { compactDuration } from '../lib/format';
import { providerVar } from '../lib/providers';
import { now, settings } from '../store';
import type { PoolLine, ProviderPool } from './poolModel';
import { ProviderGlyph } from './ui';

/** Selection id for every provider at once. */
export const ALL_PROVIDERS = 'all';
const ICON_PX = 14;
/** An account's segment fills to what it has left. */
const FULL = 100;

interface CardsProps {
  pools: ProviderPool[];
  /** Adds the All card first. */
  showAll: boolean;
  total: number;
  selected: string | null;
  /** Window length the chart shows; its line is highlighted on every card. */
  windowMs: string | null;
  onSelect: (id: string) => void;
  onWindow: (ms: string) => void;
}

/** Provider cards: each filters the page to its provider and shows every window length, one line each. */
export function ProviderCards(props: CardsProps) {
  return (
    <div class="pool-cards">
      <Show when={props.showAll}>
        <button type="button" class="pool-card all" classList={{ active: props.selected === ALL_PROVIDERS }} onClick={() => props.onSelect(ALL_PROVIDERS)}>
          <Layers size={ICON_PX} /> All <span class="count">{props.total}</span>
        </button>
      </Show>
      <For each={props.pools}>
        {(p) => {
          const chosen = () => p.lines().find((l) => l.ms === props.windowMs);
          const rate = () => chosen()?.model.rate();
          return (
            <div class="pool-card" classList={{ active: props.selected === p.id }} style={{ '--pool-color': providerVar(p.id) }} onClick={() => props.onSelect(p.id)}>
              {/* The card's keyboard target; its click bubbles to the card. */}
              <button type="button" class="pool-card-head" aria-pressed={props.selected === p.id}>
                <ProviderGlyph provider={p.id} />
                <span class="pool-card-name">{providerLabel(p.id)}</span>
                <span class="count">{p.count()}</span>
                <span class="pool-card-plans truncate" title="Accounts count by plan size">{p.lines()[0]?.model.plans()}</span>
                <span class="spacer" />
                <Show when={rate() != null}>
                  <span class="pool-card-rate" title="Drain rate of the highlighted window">~{rate()!.toFixed(1)}%/h</span>
                </Show>
              </button>
              <For each={p.lines()} fallback={<span class="muted">Not loaded yet</span>}>
                {(l) => <WindowLine line={l} chosen={l.ms === props.windowMs} onPick={() => props.onWindow(l.ms)} />}
              </For>
            </div>
          );
        }}
      </For>
    </div>
  );
}

/** One window: a segment per account, the pool's percent left, and the time to its next reset. */
function WindowLine(props: { line: PoolLine; chosen: boolean; onPick: () => void }) {
  const m = () => props.line.model;
  const t = () => settings().trayIcons;
  const level = (usedPercent: number, rejected: boolean) => (rejected ? 'critical' : trayLevel(usedPercent, t().warnAtPercentUsed, t().criticalAtPercentUsed));
  return (
    <button
      type="button"
      class="pool-line"
      classList={{ chosen: props.chosen }}
      aria-pressed={props.chosen}
      title={`Chart the ${props.line.label()} window`}
      onClick={(e) => {
        // Picks the window only; the provider filter stays.
        e.stopPropagation();
        props.onPick();
      }}
    >
      <span class="pool-line-label truncate">{props.line.label()}</span>
      <span class="pool-segments">
        <For each={m().segments()}>
          {(s) => (
            <span style={{ 'flex-grow': s.share }}>
              <span class={`fill ${level(s.usedPercent, s.rejected)}`} style={{ width: `${Math.max(0, FULL - s.usedPercent)}%` }} />
            </span>
          )}
        </For>
      </span>
      <span class="pool-line-pct">{Math.round(m().summary()?.remaining ?? 0)}%</span>
      <span class="pool-line-reset">
        <Show when={m().resetAt()}>
          {(at) => (
            <span title={new Date(at()).toLocaleString()}>
              <RotateCcw size="1em" role="img" aria-label="Resets in" /> {compactDuration(at() - now())}
            </span>
          )}
        </Show>
      </span>
    </button>
  );
}
