import { For, Show } from 'solid-js';
import { THINKING_BUCKETS, TURN_KINDS, type Alternative, type BucketStat, type SettingReport, type ThinkingReport } from '@shared/thinking';
import { usd } from '../lib/format';
import {
  alternativeMethod, alternativeName, cheaperModel, estimatedLowerEffort, KIND_TEXT, lowerEffort, mixedOption, perWeek, settingName, share,
} from '../lib/thinkingReport';

const BUCKET_NAME = { light: 'Light', typical: 'Typical', heavy: 'Heavy' } as const;

/** The verdict's line after the thinking share, from the buckets: says where the thinking cost sits. */
function whereLine(s: SettingReport): string {
  const heavy = s.buckets.find((b) => b.bucket === 'heavy');
  return heavy && heavy.turns > 0 ? `${share(heavy.turnShare)} of turns carry ${share(heavy.thinkingCostShare)} of it.` : 'None of your turns think heavily.';
}

function Saving(props: { label: string; alt: Alternative | undefined; empty: string }) {
  return (
    <div>
      <div class="think-alt-l">{props.label}</div>
      <Show when={props.alt?.savingUsdPerWeek != null && props.alt} fallback={<div class="think-alt-s">{props.empty}</div>}>
        {(a) => <>
          <div class="think-alt-v">{usd(a().savingUsdPerWeek!, 0)}<small>a week saved</small></div>
          <div class="think-alt-s">Switch to <b>{settingName(a().setting)}</b> · {share(a().savingShare ?? 0)} less · estimate</div>
        </>}
      </Show>
    </div>
  );
}

/** One setting: its thinking share, then the estimated saving at a lower effort and on a cheaper model. */
export function Verdict(props: { s: SettingReport }) {
  const lower = () => lowerEffort(props.s);
  return (
    <div class="think-verdict">
      <p class="think-say"><span class="num">{share(props.s.thinkingShare)}</span> of what you spend on <b>{settingName(props.s.setting)}</b> is thinking. {whereLine(props.s)}</p>
      <div class="think-alts">
        <Saving label="Same model, lower effort" alt={estimatedLowerEffort(props.s)}
          empty={lower() ? `Not enough of your turns at ${lower()!.setting.effort} to estimate.` : 'No lower effort to compare.'} />
        <Saving label="Cheaper model, same effort" alt={cheaperModel(props.s)} empty="No cheaper model on your accounts." />
      </div>
      <div class="think-status">Estimates only, not tested yet.</div>
    </div>
  );
}

function Bar(props: { buckets: BucketStat[]; value: (b: BucketStat) => number; label: string; what: string }) {
  return (
    <div class="think-bar-row">
      <span class="think-bar-l">{props.label}</span>
      <div class="think-bar" role="img" aria-label={`${props.label}: ${props.buckets.map((b) => `${BUCKET_NAME[b.bucket]} ${share(props.value(b))}`).join(', ')}`}>
        <For each={props.buckets}>
          {(b) => (
            <Show when={props.value(b) > 0}>
              <span class={`think-seg ${b.bucket}`} style={{ 'flex-grow': props.value(b) }} title={`${BUCKET_NAME[b.bucket]} turns: ${share(props.value(b))} of ${props.what}`}>
                {share(props.value(b))}
              </span>
            </Show>
          )}
        </For>
      </div>
    </div>
  );
}

/** Share of turns against share of thinking cost for light, typical and heavy turns, then the weekly thinking cost of each. */
export function ThinkingMix(props: { report: ThinkingReport; s: SettingReport; series: string }) {
  const heavy = () => props.s.buckets.find((b) => b.bucket === 'heavy');
  return (
    <div class={`think-mix ${props.series}`}>
      <div class="think-mix-name"><span class="swatch" />{settingName(props.s.setting)}</div>
      <p class="think-mix-say num">
        <Show when={heavy()?.turns} fallback="No heavy turns in this range.">{share(heavy()!.turnShare)} of turns carry {share(heavy()!.thinkingCostShare)} of the thinking cost.</Show>
      </p>
      <Bar buckets={props.s.buckets} value={(b) => b.turnShare} label="Turns" what="turns" />
      <Bar buckets={props.s.buckets} value={(b) => b.thinkingCostShare} label="Thinking cost" what="thinking cost" />
      <table class="table think-mini">
        <thead><tr><th>Turns that think</th><th class="num">Turns</th><th class="num">Of thinking</th><th class="num">Thinking a week</th></tr></thead>
        <tbody>
          <For each={THINKING_BUCKETS}>
            {(bucket) => {
              const b = () => props.s.buckets.find((x) => x.bucket === bucket)!;
              return (
                <tr><td><span class="think-key"><span class={`think-dot ${bucket}`} />{BUCKET_NAME[bucket]}</span></td>
                  <td class="num">{share(b().turnShare)}</td><td class="num">{share(b().thinkingCostShare)}</td><td class="num">{usd(perWeek(props.report, b().thinkingCostUsd))}</td></tr>
              );
            }}
          </For>
        </tbody>
      </table>
    </div>
  );
}

/** Turns by shape for one setting: cost, thinking share and the estimated saving at the lower effort, then the mixed recommendation. */
export function KindsTable(props: { report: ThinkingReport; s: SettingReport }) {
  const lower = () => estimatedLowerEffort(props.s) ?? lowerEffort(props.s);
  const saved = () => props.s.kinds.reduce((sum, k) => sum + (k.lowerEffortSavingUsdPerWeek ?? 0), 0);
  const mixed = () => mixedOption(props.s);
  const lowerName = () => lower()?.setting.effort ?? 'a lower effort';
  return (
    <>
      <div class="table-wrap think-wrap">
        <table class="table think-table">
          <thead><tr>
            <th>Kind of turn</th><th class="num">Turns a week</th><th class="num">Cost a week</th><th class="num">Thinking share</th>
            <th class="num">Saving at {lowerName()}<small>estimate, a week</small></th>
          </tr></thead>
          <tbody>
            <For each={TURN_KINDS}>
              {(kind) => {
                const k = () => props.s.kinds.find((x) => x.kind === kind)!;
                return (
                  <tr>
                    <td class="name">{KIND_TEXT[kind].name}<small>{KIND_TEXT[kind].rule}</small></td>
                    <td class="num">{Math.round(perWeek(props.report, k().turns)).toLocaleString()}<span class="sub">{share(props.s.turns ? k().turns / props.s.turns : 0)}</span></td>
                    <td class="num">{usd(perWeek(props.report, k().costUsd), 0)}<span class="sub">{share(k().costShare)}</span></td>
                    <td class="num">{share(k().thinkingShare)}</td>
                    <td class="num">{k().lowerEffortSavingUsdPerWeek === null ? <span class="muted">not enough data</span> : usd(k().lowerEffortSavingUsdPerWeek!, 0)}</td>
                  </tr>
                );
              }}
            </For>
          </tbody>
          <tfoot><tr>
            <td>All turns</td><td class="num">{Math.round(perWeek(props.report, props.s.turns)).toLocaleString()}</td><td class="num">{usd(props.s.costUsdPerWeek, 0)}</td>
            <td class="num">{share(props.s.thinkingShare)}</td><td class="num">{saved() > 0 ? usd(saved(), 0) : '—'}</td>
          </tr></tfoot>
        </table>
      </div>
      <Show when={mixed()?.savingUsdPerWeek != null && mixed()} fallback={<p class="think-rec-sub">Not enough of your own turns at a lower effort to estimate a saving yet.</p>}>
        {(m) => <>
          <p class="think-rec">{m().setting.effort[0]!.toUpperCase()}{m().setting.effort.slice(1)} could save about {usd(m().savingUsdPerWeek!, 0)}/week on quick questions and small changes. Test it before you switch.</p>
          <p class="think-rec-sub">The saving is an estimate. It doesn't say whether the answers would be as good.</p>
        </>}
      </Show>
    </>
  );
}

/** What the setting costs now, then each alternative's estimated weekly cost and saving. */
export function AlternativesTable(props: { s: SettingReport }) {
  return (
    <div class="table-wrap think-wrap end">
      <table class="table think-table">
        <thead><tr>
          <th>Setting</th><th class="num">Cost a week<small>estimate</small></th><th class="num">Saving a week<small>estimate</small></th>
          <th class="num">Cost per turn<small>median</small></th><th>How it's worked out</th>
        </tr></thead>
        <tbody>
          <tr class="now">
            <td class="name">{settingName(props.s.setting)}<small>what you use now</small></td><td class="num">{usd(props.s.costUsdPerWeek, 0)}</td>
            <td class="num muted">–</td><td class="num">{usd(props.s.medianTurnCostUsd)}</td><td class="how">What you spent, as a weekly average.</td>
          </tr>
          <For each={props.s.alternatives}>
            {(a) => (
              <tr>
                <td class="name">{alternativeName(props.s, a)}</td>
                <td class="num">{a.costUsdPerWeek === null ? '—' : usd(a.costUsdPerWeek, 0)}</td>
                <td class="num">{a.savingUsdPerWeek === null ? '—' : <><b>{usd(a.savingUsdPerWeek, 0)}</b><span class="sub">{share(a.savingShare ?? 0)}</span></>}</td>
                <td class="num">{a.medianTurnCostUsd === null ? '—' : usd(a.medianTurnCostUsd)}</td>
                <td class="how">{alternativeMethod(props.s, a)}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}

/** How the figures are worked out. */
export function ThinkingMethod() {
  return (
    <ul class="think-how">
      <li>A turn is one prompt from you through everything the agent does, subagents included, until it stops.</li>
      <li>A lower effort is estimated from your own turns: thinking is scaled by how much less your turns of the same kind think at that effort. With too few such turns there is no estimate.</li>
      <li>A cheaper model reprices the same tokens at that model's list prices.</li>
      <li>Costs are API list prices. On a subscription, read them as how fast you use your limits.</li>
      <li>Estimates don't say whether the answers would be as good.</li>
    </ul>
  );
}
