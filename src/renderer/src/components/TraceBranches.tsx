import { RefreshCw } from 'lucide-solid';
import { For, Show } from 'solid-js';
import type { TraceCoverage, TraceNode } from '@shared/sessionTrace';
import { shownText } from '../store';
import { compactNumber, dateTime } from '../lib/format';
import { costText, KIND_BADGE, nodeLabel } from '../lib/traceFormat';
import { HoverTip, InfoTip } from './ChartTip';

const EVIDENCE_NOTE = 'Parents come only from proxy parent-session metadata; subagents carry a claude:/codex: …:agent: ID. Retention removes old attempts: archived links keep session, effort and transport, not tokens, cost or account. Pages are a live read; refresh after new traffic. Range: up to 90 days, 7 by default.';

const ICON_PX = 14;
const shortDay = (at: string) => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** Ranked trace nodes: name and own cost, then kind, failures and volume. */
export function TraceBranches(props: { coverage?: TraceCoverage; nodes: TraceNode[]; busy: boolean; more: boolean; selected?: string; onSelect: (n: TraceNode) => void; onMore: () => void; onRefresh: () => void }) {
  return (
    <section class="card trace-branches">
      <div class="panel-head">
        <h2 class="card-title">Branches</h2>
        <span class="panel-count">{props.nodes.length.toLocaleString()}{props.more ? '+' : ''}</span>
        <span class="panel-head-end panel-count">
        <Show when={props.coverage}>{(c) => (
          <>
            {shortDay(c().from)} – {shortDay(c().to)}
            <InfoTip title="Coverage" rows={[
              { label: 'From', value: dateTime(c().from) },
              { label: 'To', value: dateTime(c().to) },
              { label: 'Requests read', value: c().scanned.toLocaleString() },
              { label: 'Read limit', value: c().limit.toLocaleString() },
              { label: 'Invalid links dropped', value: c().rejected.toLocaleString() },
            ]} note={EVIDENCE_NOTE} />
          </>
        )}</Show>
          <button class="btn icon-btn ghost" type="button" title="Refresh" aria-label="Refresh" disabled={props.busy} onClick={() => props.onRefresh()}><RefreshCw size={ICON_PX} /></button>
        </span>
      </div>
      <div class="record-list" aria-busy={props.busy}>
        <For each={props.nodes} fallback={<p class="empty">{props.busy ? 'Loading…' : 'No branches in this range.'}</p>}>
          {(n) => (
            <button type="button" class="trace-node" aria-pressed={props.selected === n.id} onClick={() => props.onSelect(n)}>
              <span class="trace-node-top">
                <span class="trace-node-name">{shownText(nodeLabel(n))}</span>
                <span class="trace-node-cost">{costText(n.metrics.costUsd)}</span>
              </span>
              <span class="trace-node-meta">
                <Show when={n.kind !== 'session'}><span class={`badge compact ${KIND_BADGE[n.kind].tone}`}>{KIND_BADGE[n.kind].label}</span></Show>
                <Show when={n.metrics.failed}><span class="badge compact red">{n.metrics.failed} failed</span></Show>
                <Show when={n.conflictingParents || n.parents.some((p) => p.cycle)}>
                  <HoverTip title="Parent links" rows={[{ label: 'Issue', value: n.conflictingParents ? 'Conflicting parents' : 'Cycle' }]} note="No single ancestry is chosen.">
                    <span class="badge compact amber">{n.conflictingParents ? 'Conflict' : 'Cycle'}</span>
                  </HoverTip>
                </Show>
                <span>{n.metrics.attempts.toLocaleString()} req</span>
                <Show when={n.metrics.tokens !== null}><span>{compactNumber(n.metrics.tokens!)} tok</span></Show>
                <span class="trace-node-time">{dateTime(n.lastAt)}</span>
              </span>
            </button>
          )}
        </For>
      </div>
      <Show when={props.more}>
        <button class="btn ghost list-more" type="button" disabled={props.busy} onClick={() => props.onMore()}>Load more</button>
      </Show>
    </section>
  );
}
