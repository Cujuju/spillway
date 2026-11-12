import { createMemo, createResource, createSignal, For, onCleanup, Show } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { Activity, CircleAlert, CircleCheck, CircleDashed } from 'lucide-solid';
import type { ActivityScope } from '@shared/activityScope';
import type { DriftSeries } from '@shared/drift';
import { dayLabel } from '../lib/format';
import { persistedSignal, isStringOrNull } from '../lib/persisted';
import { seriesLabel, summarizeSeries, verdict } from '../lib/driftView';
import { rangeDays } from '../lib/canaryView';
import { settings } from '../store';
import { CanaryPanel } from './CanaryPanel';
import { DriftChanges } from './DriftChanges';
import { DriftMetric } from './DriftMetric';
import { Notice, ProviderGlyph } from './ui';
import { appLocale } from '@shared/timeFormat';

const ICON_PX = 18;
/** Series offered as chips; the rest are rare model/effort pairs with too few replies to judge. */
const MAX_SERIES_CHIPS = 8;
const VERDICT_ICON = { steady: CircleCheck, unusual: CircleAlert, unknown: CircleDashed } as const;

function SeriesChip(props: { s: DriftSeries; selected: boolean; flagged: number; onPick: () => void }) {
  return (
    <button type="button" role="tab" class="drift-chip" classList={{ selected: props.selected }} aria-selected={props.selected} onClick={() => props.onPick()}>
      <ProviderGlyph provider={props.s.provider} size="sm" />
      <span class="drift-chip-name">{seriesLabel(props.s)}</span>
      <span class="drift-chip-count">{props.s.replies.toLocaleString(appLocale())}</span>
      <Show when={props.flagged}><span class="drift-chip-flag" title={`${props.flagged} unusual metric days this week`} /></Show>
    </button>
  );
}

/** Activity → Drift: is a model behaving differently than it did, and did the client change at the same time? */
export function DriftView(props: { scope: ActivityScope; from: string; to: string }) {
  const [revision, setRevision] = createSignal(0);
  onCleanup(window.api.onActivityReset(() => setRevision((n) => n + 1)));
  const [report] = createResource(() => (revision(), { from: props.from, to: props.to, scope: props.scope }), (q) => window.api.driftQuery(q));
  const [picked, setPicked] = persistedSignal<string | null>('activity.driftSeries', null, isStringOrNull);
  const list = () => (report.latest?.series ?? []).slice(0, MAX_SERIES_CHIPS);
  const series = createMemo(() => list().find((s) => s.key === picked()) ?? list()[0] ?? null);
  const summaries = createMemo(() => (series() ? summarizeSeries(series()!) : []));
  const flaggedDays = (s: DriftSeries) => summarizeSeries(s).reduce((n, m) => n + m.flaggedDays, 0);
  const judgement = createMemo(() => (series() ? verdict(series()!, summaries()) : null));
  // Only a range longer than retention loses days; a young database just starts late.
  const retentionCut = () => rangeDays(props.from, props.to).length > settings().activity.retentionDays;
  const models = createMemo(() => [...new Set((report.latest?.series ?? []).map((s) => s.model).filter(Boolean))]);

  return (
    <div class="drift">
      <Show when={report.error}><Notice tone="error">Couldn’t load drift: {String(report.error?.message ?? report.error)}</Notice></Show>
      <Show when={retentionCut()}>
        <Notice tone="info">Activity keeps requests for {settings().activity.retentionDays} days, so this range starts empty. Raise Activity retention in Settings for a longer baseline.</Notice>
      </Show>
      <Show when={series()} fallback={
        <Show when={report.latest}>
          <div class="card drift-empty">
            <Activity size={ICON_PX} />
            <div><h3>No requests in this range</h3><p class="muted">Drift compares each model and effort with its own recent history. Pick a longer range or wider filters.</p></div>
          </div>
        </Show>
      }>
        {(s) => (
          <>
            <div class="drift-rail" role="tablist" aria-label="Model and effort">
              <For each={list()}>{(item) => <SeriesChip s={item} selected={item.key === s().key} flagged={flaggedDays(item)} onPick={() => setPicked(item.key)} />}</For>
            </div>
            <Show when={judgement()}>
              {(v) => (
                <div class={`card drift-verdict ${v().tone}`} role="status">
                  <span class="drift-verdict-icon"><Dynamic component={VERDICT_ICON[v().tone]} size={ICON_PX} /></span>
                  <div class="drift-verdict-text">
                    <h3>{v().title}</h3>
                    <p>{v().detail}</p>
                  </div>
                  <div class="drift-verdict-meta">
                    <span>{seriesLabel(s())}</span>
                    <span class="muted">{s().replies.toLocaleString(appLocale())} replies · {dayLabel(props.from)} – {dayLabel(props.to)}</span>
                  </div>
                </div>
              )}
            </Show>
            <div class="drift-grid">
              <For each={summaries()}>{(m, i) => <DriftMetric series={s()} summary={m} featured={i() === 0} />}</For>
            </div>
            <DriftChanges series={s()} />
          </>
        )}
      </Show>
      <CanaryPanel from={props.from} to={props.to} models={models()} />
    </div>
  );
}
