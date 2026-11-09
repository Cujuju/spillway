/** Fake accounts, usage history and requests: a seeded simulation, the same relative to each start time. Emails use reserved example domains (RFC 2606). */

import type { HistorySample } from '../../src/shared/types.ts';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Matches the app's stored sample spacing (HISTORY_SAMPLE_SPACING_MS), so seeded history looks recorded. */
const STEP_MS = 5 * MINUTE_MS;
/** The app keeps 14 days of usage history (historyStore.ts RETENTION_MS). */
const HISTORY_DAYS = 14;
/** Thirty calendar days, including today, match the default Activity range. */
const ACTIVITY_DAYS = 30;
/** Any fixed value works; changing it changes every generated number. */
const SEED = 20_261_031;
const FIVE_HOURS_S = 5 * 3600;
const WEEK_S = 7 * 24 * 3600;
/** Used-percent at which the proxy reports a window as a warning. */
const WARNING_PERCENT = 80;
const FULL_PERCENT = 100;

interface WindowSpec { key: string; label: string; seconds: number; cadence: 'on_use' | 'fixed' | null; scoped: boolean; /** Percent per request. */ cost: number }
interface AccountSpec {
  id: string;
  authIndex: string;
  provider: 'claude' | 'codex' | 'gemini';
  email: string | null;
  note: string;
  plan: { tier: string; type: string; label: string; multiplier: number | null } | null;
  /** Share of the hour's traffic this account takes. */
  share: number;
  models: string[];
  userAgent: string;
  windows: WindowSpec[];
  /** A config-file API key: written to config.user.yaml; the proxy lists it masked. */
  apiKey?: { family: string; key: string; masked: string };
}

/** Costs put a busy work day at roughly half a 5-hour window and a week near three quarters; `scale` sizes the plan. */
const claudeWindows = (scale: number): WindowSpec[] => [
  { key: 'five_hour', label: '5-hour', seconds: FIVE_HOURS_S, cadence: 'on_use', scoped: false, cost: 1.2 / scale },
  { key: 'seven_day', label: 'Weekly', seconds: WEEK_S, cadence: 'fixed', scoped: false, cost: 0.1 / scale },
  { key: 'seven_day_fable', label: 'Weekly · Fable', seconds: WEEK_S, cadence: 'fixed', scoped: true, cost: 0.13 / scale },
];
const codexWindows = (scale: number): WindowSpec[] => [
  { key: 'primary', label: '5-hour', seconds: FIVE_HOURS_S, cadence: 'on_use', scoped: false, cost: 1.5 / scale },
  { key: 'secondary', label: 'Weekly', seconds: WEEK_S, cadence: null, scoped: false, cost: 0.12 / scale },
];
const CLAUDE_UA = 'claude-cli/2.4.1 (external, cli)';
const CODEX_UA = 'codex_cli_rs/0.62.0 (Windows 10.0.19045; x86_64)';
const GEMINI_UA = 'GeminiCLI/0.9.0 (win32; x64)';

export const ACCOUNTS: AccountSpec[] = [
  { id: 'claude-alex@example.com.json', authIndex: 'a1c3e5', provider: 'claude', email: 'alex@example.com', note: 'Work', share: 0.4,
    plan: { tier: 'default_claude_max_20x', type: 'claude_max', label: 'Max 20x', multiplier: 20 }, models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'], userAgent: CLAUDE_UA, windows: claudeWindows(1) },
  { id: 'claude-alex@example.org.json', authIndex: 'b2d4f6', provider: 'claude', email: 'alex@example.org', note: 'Personal', share: 0.2,
    plan: { tier: 'default_claude_max_5x', type: 'claude_max', label: 'Max 5x', multiplier: 5 }, models: ['claude-opus-5-5', 'claude-sonnet-5-5'], userAgent: CLAUDE_UA, windows: claudeWindows(0.5) },
  { id: 'codex-alex@example.com.json', authIndex: 'c3e5a7', provider: 'codex', email: 'alex@example.com', note: 'Work', share: 0.25,
    plan: { tier: 'pro', type: 'pro', label: 'Pro', multiplier: null }, models: ['gpt-6.1-sol', 'gpt-6-luna'], userAgent: CODEX_UA, windows: codexWindows(1) },
  { id: 'codex-sam@example.net.json', authIndex: 'd4f6b8', provider: 'codex', email: 'sam@example.net', note: 'Side project', share: 0.1,
    plan: { tier: 'plus', type: 'plus', label: 'Plus', multiplier: null }, models: ['gpt-6.1-sol'], userAgent: CODEX_UA, windows: codexWindows(0.25) },
  { id: 'gemini-apikey-1', authIndex: 'e5a7c9', provider: 'gemini', email: null, note: 'Gemini API', share: 0.05,
    plan: null, models: ['gemini-3.5-pro'], userAgent: GEMINI_UA, windows: [],
    apiKey: { family: 'gemini', key: 'AIza-demo-not-a-real-key-7f3a', masked: 'AIza…7f3a' } },
];

/** mulberry32: small, fast and good enough for fake data. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Requests per hour by local hour: a working day with an evening tail. */
const HOURLY_RATE = [0, 0, 0, 0, 0, 0, 1, 4, 14, 26, 30, 28, 16, 24, 30, 28, 22, 12, 6, 8, 10, 6, 2, 0];
/** Keep weekends quieter while retaining enough replies for daily drift comparisons. */
const WEEKEND_FACTOR = 0.9;
const DAILY_VOLUME_WOBBLE = 0.08;
const DAILY_METRIC_WOBBLE = 0.04;
const DRIFT_SHIFT_DAYS = 4;
const THINKING_SHIFT_FACTOR = 0.55;
const OUTPUT_SHIFT_FACTOR = 0.75;
const NO_THINKING_RATE = 0.05;
const THINKING_REPLY_MEAN = 290;
const OUTPUT_REPLY_MEAN = 800;
const TTFT_MEAN_MS = 1500;
/** About 6,000 attempts across thirty days, concentrated into three useful series. */
const DAILY_SERIES = [
  { model: 'claude-opus-5-5', effort: 'high', attempts: 84 },
  { model: 'gpt-6.1-sol', effort: 'high', attempts: 44 },
  { model: 'claude-sonnet-5-5', effort: 'medium', attempts: 44 },
  { model: 'claude-haiku-5-5', effort: 'low', attempts: 12 },
  { model: 'gpt-6-luna', effort: 'medium', attempts: 10 },
  { model: 'gemini-3.5-pro', effort: 'high', attempts: 8 },
];
interface PlannedReply { account: AccountSpec; model: string; effort: string; failed: boolean; at: number; metricScale: number; shifted: boolean }

/** A daily quota avoids random gaps; weighted slots preserve the working-day rhythm. */
function requestSchedule(start: number, now: number, rand: () => number): Map<number, PlannedReply[]> {
  const schedule = new Map<number, PlannedReply[]>();
  const shiftStart = new Date(now);
  shiftStart.setHours(0, 0, 0, 0);
  shiftStart.setDate(shiftStart.getDate() - DRIFT_SHIFT_DAYS + 1);
  for (const day = new Date(start); day.getTime() <= now; day.setDate(day.getDate() + 1)) {
    const end = new Date(day);
    end.setDate(end.getDate() + 1);
    const slots: number[] = [];
    for (let t = day.getTime(); t < end.getTime() && t <= now; t += STEP_MS) {
      // One overnight slot weight lets a demo launched before sunrise still show today's replies.
      const weight = Math.max(1, HOURLY_RATE[new Date(t).getHours()]!);
      for (let i = 0; i < weight; i++) slots.push(t);
    }
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    const volume = (weekend ? WEEKEND_FACTOR : 1) * (1 + (rand() * 2 - 1) * DAILY_VOLUME_WOBBLE);
    const metricScale = 1 + (rand() * 2 - 1) * DAILY_METRIC_WOBBLE;
    for (const series of DAILY_SERIES) {
      const count = Math.round(series.attempts * volume);
      const failureIndex = Math.floor(rand() * count);
      const accounts = ACCOUNTS.filter((a) => a.models.includes(series.model));
      const share = accounts.reduce((sum, a) => sum + a.share, 0);
      for (let i = 0; i < count; i++) {
        let pick = rand() * share;
        const account = accounts.find((a) => (pick -= a.share) < 0) ?? accounts[0]!;
        const slot = slots[Math.floor(rand() * slots.length)]!;
        const at = slot + Math.floor(rand() * Math.min(STEP_MS, now - slot + 1));
        const failed = series.attempts >= DAILY_SERIES[1]!.attempts ? i === failureIndex : rand() < FAILURE_RATE;
        const reply = { account, model: series.model, effort: series.effort, failed, at, metricScale,
          shifted: series.model === DAILY_SERIES[0]!.model && day.getTime() >= shiftStart.getTime() };
        const batch = schedule.get(slot) ?? [];
        batch.push(reply);
        schedule.set(slot, batch);
      }
    }
  }
  return schedule;
}

export interface FakeEvent {
  reasoning_effort?: string;
  reasoning_tokens?: number; request_settings?: { thinking: string; max_tokens: number; betas: string[] };
  downstream_transport?: 'http' | 'websocket'; upstream_transport?: 'http' | 'websocket' | 'websocket+http'; transport_fallback_reason?: string;
  at: string; request_id: string; upstream_id: string; selection_id: string; provider: string; model: string; auth_index: string;
  stream: boolean; failed: boolean; status_code: number; error?: string; latency_ms: number; ttft_ms: number;
  input_tokens: number; output_tokens: number; cached_tokens: number; cache_creation_tokens: number; session_id: string; session_kind: string; user_agent: string;
}

interface WindowState { used: number; resetsAt: number | null }
export interface DemoData {
  now: number;
  /** auth index → window key → state at `now`. */
  windows: Map<string, Map<string, WindowState>>;
  lastUsed: Map<string, number>;
  history: HistorySample[];
  events: FakeEvent[];
}

const hex = (rand: () => number, length: number) => Array.from({ length }, () => Math.floor(rand() * 16).toString(16)).join('');
const uuid = (rand: () => number) => `${hex(rand, 8)}-${hex(rand, 4)}-4${hex(rand, 3)}-a${hex(rand, 3)}-${hex(rand, 12)}`;
/** Weekly windows reset on a fixed weekly anchor; aligned to the hour like the providers' resets. */
const firstWeeklyReset = (start: number, offsetDays: number) => Math.ceil(start / HOUR_MS) * HOUR_MS + offsetDays * DAY_MS;
/** Average conversation length in requests, so sessions span realistic stretches. */
const REQUESTS_PER_SESSION = 60;
/** Share of attempts that fail upstream (rate limits, overloads). */
const FAILURE_RATE = 0.02;
/** A recent client update creates a visible drift marker. */
const SETTINGS_CHANGE_DAYS_AGO = 10;

/** Simulates ACTIVITY_DAYS of use ending at `now`. */
export function generate(now: number): DemoData {
  const rand = rng(SEED);
  const firstDay = new Date(now);
  firstDay.setHours(0, 0, 0, 0);
  firstDay.setDate(firstDay.getDate() - ACTIVITY_DAYS + 1);
  const start = firstDay.getTime();
  const changeDay = new Date(firstDay);
  changeDay.setDate(changeDay.getDate() + ACTIVITY_DAYS - 1 - SETTINGS_CHANGE_DAYS_AGO);
  const schedule = requestSchedule(start, now, rand);
  const historyFrom = now - HISTORY_DAYS * DAY_MS;
  const windows = new Map(ACCOUNTS.map((a, i) => [a.authIndex, new Map(a.windows.map((w) => [w.key, {
    used: 0, resetsAt: w.cadence === 'on_use' ? null : firstWeeklyReset(start, i + 1),
  }]))]));
  const sessions = new Map(ACCOUNTS.map((a) => [a.authIndex, { id: uuid(rand), left: 0 }]));
  const lastUsed = new Map<string, number>();
  const history: HistorySample[] = [];
  const events: FakeEvent[] = [];

  for (let t = start; t <= now; t += STEP_MS) {
    for (const account of ACCOUNTS) {
      const states = windows.get(account.authIndex)!;
      for (const spec of account.windows) {
        const w = states.get(spec.key)!;
        if (w.resetsAt !== null && t >= w.resetsAt) {
          w.used = 0;
          w.resetsAt = spec.cadence === 'on_use' ? null : w.resetsAt + spec.seconds * 1000;
        }
      }
      const replies = (schedule.get(t) ?? []).filter((reply) => reply.account === account);
      for (const [i, reply] of replies.entries()) {
        const { at, model, effort, failed, metricScale, shifted } = reply;
        const session = sessions.get(account.authIndex)!;
        if (session.left-- <= 0) Object.assign(session, { id: uuid(rand), left: Math.ceil(rand() * 2 * REQUESTS_PER_SESSION) });
        const cached = failed ? 0 : 20_000 + Math.floor(rand() * 120_000);
        // Claude counts cache reads apart from input; the others include them (modelPrices.ts CACHE_APART_FROM_INPUT).
        const apart = account.provider === 'claude';
        const input = failed ? 0 : 800 + Math.floor(rand() * 6000) + (apart ? 0 : cached);
        const changedSettings = at >= changeDay.getTime();
        events.push({
          reasoning_tokens: failed || rand() < NO_THINKING_RATE ? 0 : Math.round(THINKING_REPLY_MEAN * metricScale * (0.8 + rand() * 0.4) * (shifted ? THINKING_SHIFT_FACTOR : 1)),
          request_settings: { thinking: changedSettings ? 'adaptive' : 'enabled', max_tokens: changedSettings ? 128000 : 64000, betas: [] },
          at: new Date(at).toISOString(), request_id: hex(rand, 16), upstream_id: `msg_${hex(rand, 20)}`, selection_id: hex(rand, 12),
          provider: account.provider, model, auth_index: account.authIndex, stream: true, failed,
          reasoning_effort: effort,
          // Synthetic transport observations; unrelated to the real proxy configuration.
          downstream_transport: account.provider === 'codex' && i % 7 !== 0 ? 'websocket' : 'http',
          upstream_transport: account.provider === 'codex' ? (i % 7 === 0 ? 'websocket+http' : 'websocket') : 'http',
          ...(account.provider === 'codex' && i % 7 === 0 ? { transport_fallback_reason: 'websocket_upgrade_426' } : {}),
          status_code: failed ? 529 : 200, ...(failed ? { error: 'Overloaded' } : {}),
          latency_ms: 2000 + Math.floor(rand() * 30_000), ttft_ms: Math.round(TTFT_MEAN_MS * metricScale * (0.7 + rand() * 0.6)),
          input_tokens: input, output_tokens: failed ? 0 : Math.round(OUTPUT_REPLY_MEAN * metricScale * (0.75 + rand() * 0.5) * (shifted ? OUTPUT_SHIFT_FACTOR : 1)),
          cached_tokens: cached, cache_creation_tokens: failed || !apart ? 0 : Math.floor(rand() * 4000),
          session_id: `${account.provider}:${session.id}`, session_kind: 'root', user_agent: account.userAgent.replace(/\/[^ ]+/, account.provider === 'claude' ? changedSettings ? '/2.1.317' : '/2.1.316' : changedSettings ? '/0.166.0' : '/0.165.0'),
        });
        if (failed) continue;
        lastUsed.set(account.authIndex, at);
        for (const spec of account.windows) {
          const w = states.get(spec.key)!;
          if (w.resetsAt === null) w.resetsAt = t + spec.seconds * 1000;
          w.used = Math.min(FULL_PERCENT, w.used + spec.cost * (0.5 + rand()));
        }
      }
    }
    if (t >= historyFrom) history.push(sample(t, windows));
  }
  return { now, windows, lastUsed, history, events: events.sort((a, b) => a.at.localeCompare(b.at)) };
}

function sample(at: number, windows: DemoData['windows']): HistorySample {
  const used: HistorySample['used'] = {};
  const resets: NonNullable<HistorySample['resets']> = {};
  for (const account of ACCOUNTS) {
    for (const [key, w] of windows.get(account.authIndex)!) {
      (used[account.id] ??= {})[key] = Math.round(w.used);
      if (w.resetsAt !== null) (resets[account.id] ??= {})[key] = w.resetsAt;
    }
  }
  return { at: new Date(at).toISOString(), used, resets };
}

/** config.user.yaml's `api-keys` section for the fake API-key accounts (apiProviders.ts reads it). */
export function userConfigYaml(): string {
  const lines = ['api-keys:'];
  for (const a of ACCOUNTS) {
    if (!a.apiKey) continue;
    lines.push(`  ${a.apiKey.family}:`, `    - name: ${a.note}`, '      keys:', `        - api-key: ${a.apiKey.key}`, '      models:', ...a.models.map((m) => `        - name: ${m}`));
  }
  return `${lines.join('\n')}\n`;
}

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);
const status = (used: number) => (used >= FULL_PERCENT ? 'rejected' : used >= WARNING_PERCENT ? 'allowed_warning' : 'allowed');

/** The proxy's GET /usage/windows payload (docs/desktop-api.md in the fork). */
export function usageWindows(data: DemoData, preferred: Map<string, string>): unknown {
  const nextPick = new Map<string, string>();
  for (const a of ACCOUNTS) if (!nextPick.has(a.provider) && !a.apiKey) nextPick.set(a.provider, preferred.get(a.provider) ?? a.authIndex);
  return {
    strategy: 'soonest-reset',
    credentials: ACCOUNTS.map((a) => ({
      id: a.id, auth_index: a.authIndex, name: a.id, provider: a.provider, label: a.note, note: a.note,
      ...(a.email ? { email: a.email } : {}),
      ...(a.apiKey ? { api_key: { masked: a.apiKey.masked, success: 412, failed: 3 } } : {}),
      disabled: false, status: 'active', status_message: '', priority: 0, cooldown_until: null, weight: 1, plan: a.plan,
      reset_credits: a.provider === 'codex' ? { available: 1, applicable: 0, checked_at: iso(data.now), expiries: [iso(data.now + 24 * DAY_MS)] } : null,
      observed_at: iso(data.now), last_used_at: iso(data.lastUsed.get(a.authIndex)),
      next_pick: nextPick.get(a.provider) === a.authIndex, preferred: preferred.get(a.provider) === a.authIndex,
      windows: a.windows.map((spec) => {
        const w = data.windows.get(a.authIndex)!.get(spec.key)!;
        return { key: spec.key, label: spec.label, used_percent: Math.round(w.used), resets_at: iso(w.resetsAt), status: status(w.used),
          duration_seconds: spec.seconds, scoped: spec.scoped, reset_cadence: spec.cadence };
      }),
    })),
  };
}
