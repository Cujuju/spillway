import { For, Show } from 'solid-js';
import { Flame } from '@/lib/icons';
import type { PromptBucketId, TopWasteSession, WasteDriverTag, WasteReport } from '@shared/activityWaste';
import { appLocale } from '@shared/timeFormat';
import { modelName } from '../lib/comboSelection';
import { conversationLabel, conversationName } from '../lib/conversationNames';
import { compactNumber, dayLabel, usd } from '../lib/format';
import { Notice, ProviderGlyph } from './ui';

const EMPTY_ICON_PX = 18;
const PERCENT = 100;
const HOT_PROMPT_TOKENS = 350_000;
const WARN_PROMPT_TOKENS = 200_000;
const LOW_CACHE_HIT_RATE = 0.85;

type BarTone = 'default' | 'amber' | 'red' | 'green' | 'series';

const BUCKET_TONE: Record<PromptBucketId, BarTone> = {
  under100k: 'default',
  '100kTo200k': 'default',
  '200kTo350k': 'amber',
  over350k: 'red',
};

const shareText = (ratio: number): string => `${Math.round(ratio * PERCENT)}%`;
const barWidth = (ratio: number): string => `${Math.min(PERCENT, Math.max(0, ratio * PERCENT)).toFixed(1)}%`;
const plural = (n: number, one: string, many: string): string => `${n.toLocaleString(appLocale())} ${n === 1 ? one : many}`;

function driverChip(tag: WasteDriverTag, s: TopWasteSession): { label: string; tone: 'amber' | 'red' | 'neutral' } {
  switch (tag) {
    case 'over350k': return { label: '350K+ prompt', tone: 'red' };
    case 'over200k': return { label: '200K+ prompt', tone: 'amber' };
    case 'idleWakes': return { label: plural(s.idleWakes, 'idle wake', 'idle wakes'), tone: 'amber' };
    case 'midTurnMisses': return { label: plural(s.midTurnMisses, '≤5m cold miss', '≤5m cold misses'), tone: 'red' };
    case 'effortSwitch': return { label: plural(s.effortSwitches, 'effort switch', 'effort switches'), tone: 'neutral' };
    case 'modelSwitch': return { label: plural(s.modelSwitches, 'model switch', 'model switches'), tone: 'neutral' };
    case 'lowCache': return { label: 'low cache', tone: 'amber' };
  }
}

function Stat(props: { label: string; value: string; sub: string; title?: string }) {
  return (
    <div class="stat-cell" title={props.title}>
      <div class="stat-label">{props.label}</div>
      <div class="stat-value">{props.value}</div>
      <div class="stat-sub truncate">{props.sub}</div>
    </div>
  );
}

function BarRow(props: { label: string; costUsd: number; share: number; count?: string; tone?: BarTone }) {
  return (
    <div class="waste-bar-row">
      <span class="waste-bar-label">{props.label}</span>
      <span class="waste-bar-track">
        <span class={`waste-bar-fill${props.tone && props.tone !== 'default' ? ` ${props.tone}` : ''}`} style={{ width: barWidth(props.share) }} />
      </span>
      <span class="waste-bar-meta">
        <span class="waste-bar-cost">{usd(props.costUsd)}</span>
        <span class="waste-bar-share">{shareText(props.share)}</span>
        <Show when={props.count}><span class="waste-bar-count">· {props.count}</span></Show>
      </span>
    </div>
  );
}

/** Activity → Waste: prompt-size spend, cost anatomy, cold cache misses, and top burn sessions. */
export function WasteView(props: { report: WasteReport | null | undefined; retentionDays: number }) {
  const anatomyRows = (r: WasteReport) => {
    const total = r.totalCostUsd;
    const shareOf = (v: number) => (total > 0 ? v / total : 0);
    return [
      { label: 'Uncached input', costUsd: r.anatomy.uncachedInputUsd, share: shareOf(r.anatomy.uncachedInputUsd), tone: 'amber' as BarTone },
      { label: 'Cache writes', costUsd: r.anatomy.cacheWriteUsd, share: shareOf(r.anatomy.cacheWriteUsd), tone: 'series' as BarTone },
      { label: 'Cache reads', costUsd: r.anatomy.cacheReadUsd, share: shareOf(r.anatomy.cacheReadUsd), tone: 'green' as BarTone },
      { label: 'Output', costUsd: r.anatomy.outputUsd, share: shareOf(r.anatomy.outputUsd), tone: 'default' as BarTone },
    ];
  };

  const promptCost = (r: WasteReport) => r.anatomy.uncachedInputUsd + r.anatomy.cacheWriteUsd + r.anatomy.cacheReadUsd;
  const promptShare = (r: WasteReport) => (r.totalCostUsd > 0 ? promptCost(r) / r.totalCostUsd : 0);
  const over200kReqs = (r: WasteReport) => r.promptBuckets
    .filter((b) => b.id === '200kTo350k' || b.id === 'over350k')
    .reduce((sum, b) => sum + b.requests, 0);
  const retentionCut = (r: WasteReport) => r.retained !== null && r.retained.from > r.range.from;

  return (
    <div class="waste">
      <Show when={props.report === null}>
        <Notice tone="error">Couldn’t load waste breakdown.</Notice>
      </Show>
      <Show when={props.report}>
        {(r) => (
          <>
            <Show when={retentionCut(r()) && r().retained}>
              {(ret) => (
                <Notice tone="info">
                  Activity keeps requests for {props.retentionDays} days, so Waste covers {dayLabel(ret().from)} – {dayLabel(ret().to)}.
                </Notice>
              )}
            </Show>

            <Show when={r().requests > 0} fallback={
              <div class="card waste-empty">
                <Flame size={EMPTY_ICON_PX} />
                <div>
                  <h3>No retained requests in this range</h3>
                  <p class="muted">Waste inspects retained requests for prompt bloat, cold cache misses, and high-burn sessions. Pick a wider range or filters.</p>
                </div>
              </div>
            }>
              <div class="card stat-strip">
                <Stat
                  label="Analyzed spend"
                  value={usd(r().totalCostUsd)}
                  sub={`${r().requests.toLocaleString(appLocale())} reqs${r().unpricedRequests ? ` · ${r().unpricedRequests.toLocaleString(appLocale())} unpriced` : ''}`}
                />
                <Stat
                  label="Prompts > 200K"
                  value={shareText(r().over200kShare)}
                  sub={`${usd(r().over200kCostUsd)} · avg ${compactNumber(r().avgPromptTokens)} · p90 ${compactNumber(r().p90PromptTokens)}`}
                  title="Share of priced spend on requests with prompts over 200K tokens"
                />
                <Stat
                  label="Cold cache misses"
                  value={usd(r().coldMisses.total.costUsd)}
                  sub={`${r().coldMisses.total.requests.toLocaleString(appLocale())} reqs · ${r().coldMisses.afterIdle.requests} idle · ${r().coldMisses.midTurn.requests} ≤5m${r().coldMisses.unclassified.requests ? ` · ${r().coldMisses.unclassified.requests} no prior` : ''}`}
                  title="Uncached input and cache-write spend on prompts > 80K with > 50K cold tokens and < 70% cache hit"
                />
                <Stat
                  label="Prompt share of bill"
                  value={shareText(promptShare(r()))}
                  sub={`${usd(promptCost(r()))} prompt · ${usd(r().anatomy.outputUsd)} output`}
                  title="Uncached input, cache writes, and cache reads compared against output spend"
                />
              </div>

              <div class="waste-grid">
                <section class="card waste-card">
                  <div class="chart-head">
                    <h2 class="section-label">Spend by prompt size</h2>
                    <span class="chart-head-note">avg {compactNumber(r().avgPromptTokens)} · p90 {compactNumber(r().p90PromptTokens)}</span>
                  </div>
                  <div class="waste-bars">
                    <For each={r().promptBuckets}>
                      {(b) => (
                        <BarRow
                          label={b.label}
                          costUsd={b.costUsd}
                          share={b.share}
                          count={`${b.requests.toLocaleString(appLocale())} reqs`}
                          tone={BUCKET_TONE[b.id]}
                        />
                      )}
                    </For>
                  </div>
                  <dl class="waste-ledger">
                    <dt>Average prompt</dt>
                    <dd>{compactNumber(r().avgPromptTokens)} tokens</dd>
                    <dt>90th percentile prompt</dt>
                    <dd>{compactNumber(r().p90PromptTokens)} tokens</dd>
                    <dt>Requests &gt; 200K</dt>
                    <dd>{over200kReqs(r()).toLocaleString(appLocale())} reqs · {usd(r().over200kCostUsd)}</dd>
                  </dl>
                </section>

                <section class="card waste-card">
                  <div class="chart-head">
                    <h2 class="section-label">Cost anatomy & cache misses</h2>
                    <span class="chart-head-note">{usd(r().totalCostUsd)} total</span>
                  </div>
                  <div class="waste-bars">
                    <For each={anatomyRows(r())}>
                      {(row) => <BarRow label={row.label} costUsd={row.costUsd} share={row.share} tone={row.tone} />}
                    </For>
                  </div>
                  <dl class="waste-ledger">
                    <dt>Cold misses (&gt;5m idle)</dt>
                    <dd>{r().coldMisses.afterIdle.requests.toLocaleString(appLocale())} reqs · {usd(r().coldMisses.afterIdle.costUsd)}</dd>
                    <dt>Cold misses (≤5m since prior req)</dt>
                    <dd>{r().coldMisses.midTurn.requests.toLocaleString(appLocale())} reqs · {usd(r().coldMisses.midTurn.costUsd)}</dd>
                    <Show when={r().coldMisses.unclassified.requests > 0}>
                      <dt>Cold misses (no prior req)</dt>
                      <dd>{r().coldMisses.unclassified.requests.toLocaleString(appLocale())} reqs · {usd(r().coldMisses.unclassified.costUsd)}</dd>
                    </Show>
                    <dt>Effort / model switches</dt>
                    <dd>{r().coldMisses.effortSwitches.toLocaleString(appLocale())} effort · {r().coldMisses.modelSwitches.toLocaleString(appLocale())} model</dd>
                  </dl>
                </section>
              </div>

              <section class="card table-card">
                <div class="waste-table-head">
                  <h2 class="section-label">Top burn sessions</h2>
                  <span class="chart-head-note">Highest-spend conversations in range</span>
                </div>
                <Show when={r().topSessions.length > 0} fallback={
                  <p class="muted waste-table-empty">No session-tagged requests in this range.</p>
                }>
                  <table class="table dense waste-table">
                    <thead>
                      <tr>
                        <th>Session</th>
                        <th>Model</th>
                        <th class="num">Spend</th>
                        <th class="num">Reqs</th>
                        <th class="num">Max prompt</th>
                        <th class="num">Cache hit</th>
                        <th class="num">Cold miss</th>
                        <th>Drivers</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={r().topSessions}>
                        {(s) => (
                          <tr>
                            <td class="fill session-col">
                              <div class="cell-name" title={conversationName(s.sessionId) ?? s.sessionId}>
                                <ProviderGlyph provider={s.provider} size="sm" />
                                <span>{conversationLabel(s.sessionId)}</span>
                              </div>
                            </td>
                            <td class="model-col">{modelName(s.model)}{s.effort ? ` · ${s.effort}` : ''}</td>
                            <td class="num">{usd(s.costUsd)}</td>
                            <td class="num">{s.requests.toLocaleString(appLocale())}</td>
                            <td class="num" classList={{ hot: s.maxPromptTokens > HOT_PROMPT_TOKENS, warn: s.maxPromptTokens > WARN_PROMPT_TOKENS && s.maxPromptTokens <= HOT_PROMPT_TOKENS }}>
                              {compactNumber(s.maxPromptTokens)}
                            </td>
                            <td class="num" classList={{ warn: s.maxPromptTokens > WARN_PROMPT_TOKENS && s.cacheHitRate < LOW_CACHE_HIT_RATE }}>
                              {shareText(s.cacheHitRate)}
                            </td>
                            <td class="num" classList={{ zero: s.coldMissUsd === 0 }}>
                              {s.coldMissUsd > 0 ? usd(s.coldMissUsd) : '—'}
                            </td>
                            <td>
                              <Show when={s.drivers.length > 0} fallback={<span class="muted">—</span>}>
                                <div class="waste-drivers">
                                  <For each={s.drivers}>
                                    {(tag) => {
                                      const chip = () => driverChip(tag, s);
                                      return <span class={`waste-driver${chip().tone !== 'neutral' ? ` ${chip().tone}` : ''}`}>{chip().label}</span>;
                                    }}
                                  </For>
                                </div>
                              </Show>
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </Show>
              </section>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}
