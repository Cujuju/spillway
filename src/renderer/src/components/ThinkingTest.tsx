import { createEffect, createSignal, For, on, Show, untrack } from 'solid-js';
import { settingKey, type SettingReport, type ThinkingQuery, type ThinkingSetting } from '@shared/thinking';
import { DEFAULT_TEST_TURNS, MIN_KIND_GRADED, TEST_TURN_CHOICES, type TestPlan, type ThinkingTest, type TurnGrade } from '@shared/thinkingTest';
import { dateTime, usd } from '../lib/format';
import { defaultAlternatives } from '../lib/thinkingTests';
import { KIND_TEXT, settingName } from '../lib/thinkingReport';
import { Dialog, Seg } from './ui';

/** "18 of 20 matched" with a bar; "too few to tell" under MIN_KIND_GRADED; "not tested" without a result. */
export function Matched(props: { result: { matched: number; graded: number } | undefined; small?: boolean }) {
  return (
    <Show when={props.result && props.result.graded > 0 && props.result} fallback={<span class="muted">not tested</span>}>
      {(r) => (
        <Show when={!props.small || r().graded >= MIN_KIND_GRADED} fallback={<span class="muted" title={`${r().matched} of ${r().graded} matched`}>too few to tell</span>}>
          <span class="think-hit">{r().matched} of {r().graded} matched<span class="think-hit-bar" aria-hidden="true"><i style={{ width: `${(r().matched / r().graded) * 100}%` }} /></span></span>
        </Show>
      )}
    </Show>
  );
}

/** Picks what to test, shows what the plan can replay and what it costs, then starts it. Nothing runs before Start. */
export function TestDialog(props: { s: SettingReport; query: ThinkingQuery; onStarted: (test: ThinkingTest) => void; onClose: () => void }) {
  const choices = () => props.s.alternatives.filter((a) => a.method !== 'mixed').map((a) => a.setting);
  // Starts from the verdict's two alternatives; the user's ticks own it after that.
  const [picked, setPicked] = createSignal<string[]>(untrack(() => defaultAlternatives(props.s).map(settingKey)));
  const [turns, setTurns] = createSignal<number>(DEFAULT_TEST_TURNS);
  const [plan, setPlan] = createSignal<TestPlan | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const chosen = (): ThinkingSetting[] => choices().filter((c) => picked().includes(settingKey(c)));
  const toggle = (key: string) => setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));
  let request = 0;
  // A plan is only good for the choices it was made from.
  createEffect(on([picked, turns], () => {
    const id = ++request;
    setPlan(null); setError(null);
    if (!chosen().length) return;
    window.api.thinkingTestPlan({ query: props.query, setting: props.s.setting, alternatives: chosen(), turns: turns() })
      .then((p) => { if (id === request) setPlan(p); })
      .catch((err: unknown) => { if (id === request) setError(err instanceof Error ? err.message : 'Could not plan the test'); });
  }));
  const start = async () => {
    const p = plan();
    if (!p) return;
    setBusy(true);
    try { props.onStarted(await window.api.thinkingTestStart(p.id)); props.onClose(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not start the test'); }
    finally { setBusy(false); }
  };
  const sampledTotal = () => plan()?.sampled.reduce((n, k) => n + k.turns, 0) ?? 0;

  return (
    <Dialog title={`Test ${settingName(props.s.setting)}`} onClose={props.onClose} actions={<>
      <button class="btn" type="button" onClick={props.onClose}>Cancel</button>
      <button class="btn primary" type="button" disabled={busy() || !plan() || sampledTotal() === 0} onClick={() => void start()}>
        {plan() && sampledTotal() > 0 ? `Run test · about ${usd(plan()!.estimatedCostUsd)}` : 'Run test'}
      </button>
    </>}>
      <p class="think-dialog-lede">Replays one recorded request from each sampled turn at the settings below, through your own accounts. No tools run. A model then judges whether each reply makes the same next move.</p>
      <div class="think-dialog-group">
        <div class="think-alt-l">Compare against</div>
        <For each={choices()}>
          {(c) => (
            <label class="think-check"><input type="checkbox" checked={picked().includes(settingKey(c))} onChange={() => toggle(settingKey(c))} />{settingName(c)}</label>
          )}
        </For>
      </div>
      <div class="think-dialog-group">
        <Seg label="Turns to test" value={turns()} options={TEST_TURN_CHOICES.map((n) => ({ value: n, label: `${n} turns` }))} onChange={setTurns} />
      </div>
      <Show when={error()}><p class="think-dialog-error">{error()}</p></Show>
      <Show when={plan()} fallback={<p class="muted think-dialog-note">{chosen().length ? 'Checking your recorded turns…' : 'Pick at least one setting.'}</p>}>
        {(p) => (
          <div class="think-dialog-plan">
            <p>{p().replayableTurns.toLocaleString()} of your {p().eligibleTurns.toLocaleString()} turns on {settingName(p().setting)} can be replayed.
              <Show when={sampledTotal() > 0}> The test uses {sampledTotal()}: {p().sampled.filter((k) => k.turns > 0).map((k) => `${k.turns} ${KIND_TEXT[k.kind].name.toLowerCase()}${k.turns === 1 ? '' : 's'}`).join(', ')}.</Show>
            </p>
            <Show when={p().skipped.length}>
              <ul class="think-skipped"><For each={p().skipped}>{(r) => <li>{r.turns.toLocaleString()} · {r.reason}</li>}</For></ul>
            </Show>
            <Show when={sampledTotal() === 0}><p class="think-dialog-error">Nothing to replay yet. Turn on request capture in Settings → Data, use your agent for a while, then test.</p></Show>
          </div>
        )}
      </Show>
    </Dialog>
  );
}

/** The turns a cheaper setting answered differently, with the judge's reason, then any that failed to run. */
export function MismatchDialog(props: { test: ThinkingTest; onClose: () => void }) {
  const differ = () => props.test.grades.filter((g) => g.outcome === 'differ');
  const errors = () => props.test.grades.filter((g) => g.outcome === 'error');
  const row = (g: TurnGrade) => (
    <tr><td class="num">{dateTime(g.turnAt)}</td><td>{KIND_TEXT[g.kind].name}</td><td class="name">{settingName(g.alternative)}</td><td class="how">{g.reason}</td></tr>
  );
  return (
    <Dialog title={`Turns that didn't match · ${settingName(props.test.setting)}`} onClose={props.onClose} actions={<button class="btn" type="button" onClick={props.onClose}>Close</button>}>
      <div class="table-wrap think-dialog-table">
        <table class="table think-table">
          <thead><tr><th>Turn</th><th>Kind</th><th>Replayed at</th><th>Why it differs</th></tr></thead>
          <tbody><For each={differ()}>{row}</For></tbody>
        </table>
      </div>
      <Show when={errors().length}>
        <p class="think-dialog-note muted">{errors().length} replays failed and are not counted.</p>
      </Show>
    </Dialog>
  );
}

/** A verdict's last line: not tested, testing with progress, or each alternative's result. */
export function TestStatus(props: { test: ThinkingTest | undefined; onTest: () => void; onCancel: (test: ThinkingTest) => void; onMismatches: (test: ThinkingTest) => void }) {
  const differ = () => props.test?.grades.filter((g) => g.outcome === 'differ').length ?? 0;
  return (
    <div class="think-status">
      <Show when={props.test} fallback={<><span>Estimates only, not tested yet.</span><span class="spacer" /><button class="btn" type="button" onClick={props.onTest}>Test on your turns…</button></>}>
        {(t) => (
          <Show when={t().state !== 'running'} fallback={<>
            <span>Testing · {t().done} of {t().total} replays · {usd(t().costUsd)} so far</span><span class="spacer" />
            <button class="btn" type="button" onClick={() => props.onCancel(t())}>Cancel</button>
          </>}>
            <span>
              <Show when={t().state === 'complete'} fallback={<>{t().state === 'canceled' ? 'Test canceled.' : `Test failed: ${t().error ?? 'unknown error'}`}</>}>
                <For each={t().results}>{(r, i) => <>{i() ? ' · ' : ''}<b>{settingName(r.setting)}</b> matched on {r.matched} of {r.graded}</>}</For>
              </Show>
            </span>
            <span class="spacer" />
            <Show when={differ() > 0}><button class="link" type="button" onClick={() => props.onMismatches(t())}>See the {differ()} that didn't match</button></Show>
            <button class="btn ghost" type="button" onClick={props.onTest}>Test again…</button>
          </Show>
        )}
      </Show>
    </div>
  );
}
