import { createMemo, For, Show } from 'solid-js';
import { Package, SlidersHorizontal } from 'lucide-solid';
import type { DriftSeries } from '@shared/drift';
import { dateTime } from '../lib/format';
import { changeText } from '../lib/driftView';
import { InfoTip } from './ChartTip';

const ICON_PX = 14;
/** Enough rows to cover a month of weekly client releases without crowding the canary card. */
const MAX_ROWS = 12;

/** Client version and request-settings changes in this series: the client-side explanations to rule out first. */
export function DriftChanges(props: { series: DriftSeries }) {
  const rows = createMemo(() => [...props.series.changes].sort((a, b) => b.at.localeCompare(a.at)));
  return (
    <section class="card drift-changes">
      <header class="drift-section-head">
        <h3 class="section-label">Client changes</h3>
        <InfoTip title="Client changes" note="A shift that starts the day a client updated, or its request settings changed, is more likely the client than the model. Markers on the charts show the same days." />
      </header>
      <Show when={rows().length} fallback={<p class="muted drift-changes-empty">No client version or request-settings change in this range.</p>}>
        <ol class="drift-timeline">
          <For each={rows().slice(0, MAX_ROWS)}>
            {(c) => (
              <li class={`drift-change ${c.kind}`}>
                <span class="drift-change-icon">{c.kind === 'settings' ? <SlidersHorizontal size={ICON_PX} /> : <Package size={ICON_PX} />}</span>
                <div class="drift-change-body">
                  <div class="drift-change-title">{changeText(c)}</div>
                  <div class="drift-change-when muted">{dateTime(c.at)}</div>
                  <Show when={c.details.length}>
                    <ul class="drift-change-details"><For each={c.details}>{(d) => <li>{d}</li>}</For></ul>
                  </Show>
                </div>
              </li>
            )}
          </For>
        </ol>
        <Show when={rows().length > MAX_ROWS}><p class="muted drift-changes-more">{rows().length - MAX_ROWS} older changes not shown.</p></Show>
      </Show>
    </section>
  );
}
