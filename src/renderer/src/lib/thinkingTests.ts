import { createSignal, onCleanup } from 'solid-js';
import { settingKey, type SettingReport, type ThinkingSetting, type TurnKind } from '@shared/thinking';
import type { AlternativeResult, ThinkingTest } from '@shared/thinkingTest';

/** How often a running test's progress is asked for. */
const POLL_MS = 1000;

export interface ThinkingTests {
  /** Latest test per setting (settingKey), running ones included. */
  of: (setting: ThinkingSetting) => ThinkingTest | undefined;
  started: (test: ThinkingTest) => void;
  cancel: (test: ThinkingTest) => void;
}

/** Tests kept across restarts, loaded on mount, with running ones polled until they finish. */
export function createThinkingTests(): ThinkingTests {
  const [tests, setTests] = createSignal<Record<string, ThinkingTest>>({});
  const put = (test: ThinkingTest) => setTests((all) => ({ ...all, [settingKey(test.setting)]: test }));
  void window.api.thinkingTests().then(setTests).catch((err: unknown) => console.error('[thinking] tests failed:', err));
  const timer = setInterval(() => {
    for (const test of Object.values(tests())) {
      if (test.state === 'running') void window.api.thinkingTestStatus(test.id).then(put).catch((err: unknown) => console.error('[thinking] test status failed:', err));
    }
  }, POLL_MS);
  onCleanup(() => clearInterval(timer));
  return {
    of: (setting) => tests()[settingKey(setting)],
    started: put,
    cancel: (test) => void window.api.thinkingTestCancel(test.id).then(() => window.api.thinkingTestStatus(test.id)).then(put)
      .catch((err: unknown) => console.error('[thinking] cancel failed:', err)),
  };
}

/** A tested alternative's result. */
export const resultFor = (test: ThinkingTest | undefined, setting: ThinkingSetting | undefined): AlternativeResult | undefined =>
  test && setting ? test.results.find((r) => settingKey(r.setting) === settingKey(setting)) : undefined;

/** Matched and graded across `kinds`. */
export function kindsResult(result: AlternativeResult | undefined, kinds: readonly TurnKind[]): { matched: number; graded: number } | undefined {
  if (!result) return undefined;
  const picked = result.byKind.filter((k) => kinds.includes(k.kind));
  return { matched: picked.reduce((n, k) => n + k.matched, 0), graded: picked.reduce((n, k) => n + k.graded, 0) };
}

/** The settings a test replays by default: the verdict's lower effort and closest cheaper model. */
export function defaultAlternatives(s: SettingReport): ThinkingSetting[] {
  const lower = s.alternatives.find((a) => a.method === 'effort-ratio' && a.savingUsdPerWeek !== null) ?? s.alternatives.find((a) => a.method === 'effort-ratio');
  const cheaper = s.alternatives.find((a) => a.method === 'reprice');
  return [lower, cheaper].filter((a) => a !== undefined).map((a) => a.setting);
}
