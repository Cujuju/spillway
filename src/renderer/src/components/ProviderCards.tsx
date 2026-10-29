import { ChevronDown, ChevronUp, Layers, RotateCcw } from 'lucide-solid';
import { For, Show } from 'solid-js';
import { providerLabel } from '@shared/trayValues';
import { compactDuration, quotaPercent } from '../lib/format';
import { isBoolean, persistedSignal } from '../lib/persisted';
import { quotaColor } from '../lib/quotaColor';
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
  /** Line id the chart shows; matching lines are highlighted on every card. */
  chosenLine: string | null;
  onSelect: (id: string) => void;
  onLine: (id: string) => void;
}

/** Provider cards: each filters the page to its provider and lists its windows; model and spend windows fold away. */
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
          const [expanded, setExpanded] = persistedSignal(`dashboard.cardExpanded.${p.id}`, false, isBoolean);
          const chosen = () => p.lines().find((l) => l.id === props.chosenLine);
          const rate = () => chosen()?.model.rate();
          const folded = () => p.lines().filter((l) => l.scoped).length;
          // A charted scoped line stays visible while folded.
          const shown = () => p.lines().filter((l) => !l.scoped || expanded() || l.id === props.chosenLine);
          return (
            <div class="pool-card card-wash" classList={{ active: props.selected === p.id }} style={{ '--pool-color': providerVar(p.id) }} onClick={() => props.onSelect(p.id)}>
              <div class="pool-card-top">
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
                <Show when={folded()}>
                  <button
                    type="button"
                    class="pool-card-more"
                    aria-expanded={expanded()}
                    title={expanded() ? 'Hide model and spend windows' : 'Show model and spend windows'}
                    onClick={(e) => {
                      // Folds only; the provider filter stays.
                      e.stopPropagation();
                      setExpanded(!expanded());
                    }}
                  >
                    <Show when={expanded()} fallback={<>+{folded()} <ChevronDown size={ICON_PX} /></>}>
                      <ChevronUp size={ICON_PX} />
                    </Show>
                  </button>
                </Show>
              </div>
              <For each={shown()} fallback={<span class="pool-card-empty muted">{p.keysOnly() ? 'API keys report no quota' : 'Not loaded yet'}</span>}>
                {(l) => <WindowLine line={l} chosen={l.id === props.chosenLine} onPick={() => props.onLine(l.id)} />}
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
      <span class="pool-line-label">{props.line.label()}</span>
      <span class="pool-segments">
        <For each={m().segments()}>
          {(s) => (
            <span style={{ 'flex-grow': s.share }}>
              <span class="fill" style={{ width: `${Math.max(0, FULL - s.usedPercent)}%`, background: quotaColor(s.usedPercent, s.rejected) }} />
            </span>
          )}
        </For>
      </span>
      <span class="pool-line-pct">{quotaPercent(m().summary()?.remaining ?? 0)}</span>
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
