import { CornerLeftUp, ListTree } from 'lucide-solid';
import { For, Show } from 'solid-js';
import type { TraceAttempt, TraceNode } from '@shared/sessionTrace';
import { shownText } from '../store';
import { compactNumber, dateTime } from '../lib/format';
import { conversationLabel } from '../lib/conversationNames';
import { costText, KIND_BADGE, meanText, modelLabel, nodeLabel } from '../lib/traceFormat';
import { HoverTip, InfoTip } from './ChartTip';
import { TraceAttempts } from './TraceAttempts';
import { CopyButton } from './ui';

const ICON_PX = 14;
const OWN_USAGE_NOTE = 'Totals cover this node only; parent and child costs are never added together. Cost is a list-price estimate.';

function Stats(props: { n: TraceNode }) {
  const m = () => props.n.metrics;
  return (
    <div class="stat-strip inset">
      <HoverTip layout="block" title="Cost" rows={[{ label: 'Priced', value: m().priced.toLocaleString() }, { label: 'Unpriced', value: m().unpriced.toLocaleString() }]}>
        <div class="stat-cell"><div class="stat-label">Own cost</div><div class="stat-value">{costText(m().costUsd)}</div><div class="stat-sub">{m().unpriced ? `${m().unpriced} unpriced` : 'all priced'}</div></div>
      </HoverTip>
      <HoverTip layout="block" title="Requests" rows={[
        { label: 'Via proxy', value: m().proxyAttempts.toLocaleString() },
        { label: 'Imported', value: m().importedAttempts.toLocaleString() },
        { label: 'Outcome unknown', value: m().unknownOutcomes.toLocaleString() },
        { label: 'Account moves', value: m().accountMoves.toLocaleString() },
        { label: 'Exchanges', value: props.n.exchanges.toLocaleString() },
      ]}>
        <div class="stat-cell"><div class="stat-label">Requests</div><div class="stat-value">{m().attempts.toLocaleString()}</div>
          <div class="stat-sub" classList={{ 'danger-text': m().failed > 0 }}>{m().failed ? `${m().failed} failed` : 'none failed'}</div></div>
      </HoverTip>
      <HoverTip layout="block" title="Tokens" rows={[{ label: 'With usage', value: m().usageKnown.toLocaleString() }, { label: 'Without usage', value: m().missingUsage.toLocaleString() }]}>
        <div class="stat-cell"><div class="stat-label">Tokens</div><div class="stat-value">{m().tokens === null ? '—' : compactNumber(m().tokens!)}</div><div class="stat-sub">{m().missingUsage ? `${m().missingUsage} without usage` : 'all reported'}</div></div>
      </HoverTip>
      <HoverTip layout="block" title="Latency" rows={[{ label: 'Samples', value: m().latencyCount.toLocaleString() }, { label: 'TTFT samples', value: m().ttftCount.toLocaleString() }]}>
        <div class="stat-cell"><div class="stat-label">Avg latency</div><div class="stat-value">{meanText(m().latencySumMs, m().latencyCount)}</div><div class="stat-sub">TTFT {meanText(m().ttftSumMs, m().ttftCount)}</div></div>
      </HoverTip>
      <div class="stat-cell"><div class="stat-label">Active</div><div class="stat-value">{dateTime(props.n.lastAt)}</div><div class="stat-sub">since {dateTime(props.n.firstAt)}</div></div>
    </div>
  );
}

/** One node: identity, own-usage stats, models, parent links and its attempts. */
export function TraceDetail(props: {
  n: TraceNode; attempts: TraceAttempt[]; busy: boolean; more: boolean; error: string | null;
  account: (id: string | null) => string; onInspect: (traceId: string) => void; onNavigate: (sessionId: string) => void;
  onChildren: (sessionId: string) => void; onMore: () => void;
}) {
  const kind = () => KIND_BADGE[props.n.kind];
  return (
    <section class="card trace-detail">
      <div class="panel-head">
        <h2 class="card-title trace-title">{shownText(nodeLabel(props.n))}</h2>
        <span class={`badge ${kind().tone}`}>{kind().label}</span>
        <InfoTip title="Own usage" note={OWN_USAGE_NOTE} />
        <div class="panel-head-end">
          <Show when={props.n.sessionId}>{(id) => <>
            <CopyButton value={id()} what="session ID" label="Copy ID" ghost />
            <button class="btn ghost" type="button" onClick={() => props.onChildren(id())}><ListTree size={ICON_PX} />Children</button>
          </>}</Show>
        </div>
      </div>

      <Stats n={props.n} />

      <dl class="kv-grid">
        <div class="kv"><dt>Models</dt><dd class="tag-row"><For each={props.n.models} fallback={<span class="muted">—</span>}>{(m) => <span class="badge">{shownText(modelLabel(m))}</span>}</For></dd></div>
        <div class="kv"><dt>Effort</dt><dd class="tag-row"><For each={props.n.efforts} fallback={<span class="muted">—</span>}>{(e) => <span class="badge">{e}</span>}</For></dd></div>
        <div class="kv"><dt>Parent</dt><dd class="tag-row">
          <For each={props.n.parents} fallback={<span class="muted">None recorded</span>}>{(p) => (
            <HoverTip title="Parent" rows={[
              { label: 'Session', value: shownText(p.sessionId) },
              { label: 'Link', value: p.kind === 'subagent' ? 'Subagent' : 'Unclassified' },
              { label: 'In range', value: p.observed ? 'Yes' : 'No' },
              ...(p.cycle ? [{ label: 'Cycle', value: 'Yes' }] : []),
            ]} layout="contents">
              <button type="button" class="btn ghost trace-parent" onClick={() => props.onNavigate(p.sessionId)}><CornerLeftUp size={ICON_PX} />{shownText(conversationLabel(p.sessionId))}</button>
            </HoverTip>
          )}</For>
          <Show when={props.n.conflictingParents}><span class="badge compact amber">Conflict</span></Show>
          <Show when={props.n.parentCount > props.n.parents.length}><span class="muted">+{props.n.parentCount - props.n.parents.length}</span></Show>
        </dd></div>
      </dl>

      <div class="panel-head trace-attempts-head">
        <h3 class="section-label">Attempts</h3>
        <span class="panel-count">{props.attempts.length.toLocaleString()}{props.more ? '+' : ''}</span>
      </div>
      <Show when={props.error}>{(e) => <p class="notice error">{shownText(e())}</p>}</Show>
      <TraceAttempts attempts={props.attempts} busy={props.busy} account={props.account} onInspect={props.onInspect} />
      <Show when={props.more}><button class="btn ghost list-more" type="button" disabled={props.busy} onClick={() => props.onMore()}>Load more</button></Show>
    </section>
  );
}
