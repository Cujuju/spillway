/** Fake accounts, usage history and requests: a seeded simulation, the same relative to each start time. Emails use reserved example domains (RFC 2606). */

import type { HistorySample } from '../../src/shared/types.ts';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Matches the app's stored sample spacing (HISTORY_SAMPLE_SPACING_MS), so seeded history looks recorded. */
const STEP_MS = 5 * MINUTE_MS;
/** The app keeps 14 days of usage history (historyStore.ts RETENTION_MS). */
const HISTORY_DAYS = 14;
/** Inside the app's default 30-day activity retention, with room for the heatmap to show weeks. */
const ACTIVITY_DAYS = 28;
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
const WEEKEND_FACTOR = 0.3;

function hourlyRate(at: number): number {
  const d = new Date(at);
  const weekend = d.getDay() === 0 || d.getDay() === 6;
  return HOURLY_RATE[d.getHours()]! * (weekend ? WEEKEND_FACTOR : 1);
}

/** Poisson draw by inversion; fine for the small means used here. */
function poisson(mean: number, rand: () => number): number {
  const limit = Math.exp(-mean);
  let k = 0;
  for (let p = rand(); p > limit; p *= rand()) k++;
  return k;
}

export interface FakeEvent {
  at: string; request_id: string; upstream_id: string; selection_id: string; provider: string; model: string; auth_index: string;
  stream: boolean; failed: boolean; status_code: number; error?: string; latency_ms: number; ttft_ms: number;
  input_tokens: number; output_tokens: number; cached_tokens: number; cache_creation_tokens: number; session_id: string; user_agent: string;
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

/** Simulates ACTIVITY_DAYS of use ending at `now`. */
export function generate(now: number): DemoData {
  const rand = rng(SEED);
  const start = now - ACTIVITY_DAYS * DAY_MS;
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
      const blocked = account.windows.some((spec) => !spec.scoped && states.get(spec.key)!.used >= FULL_PERCENT);
      const count = blocked ? 0 : poisson((hourlyRate(t) * account.share * STEP_MS) / HOUR_MS, rand);
      for (let i = 0; i < count; i++) {
        const at = t + Math.floor(rand() * STEP_MS);
        const session = sessions.get(account.authIndex)!;
        if (session.left-- <= 0) Object.assign(session, { id: uuid(rand), left: Math.ceil(rand() * 2 * REQUESTS_PER_SESSION) });
        const model = account.models[Math.floor(rand() * account.models.length)]!;
        const failed = rand() < FAILURE_RATE;
        const cached = failed ? 0 : 20_000 + Math.floor(rand() * 120_000);
        // Claude counts cache reads apart from input; the others include them (modelPrices.ts CACHE_APART_FROM_INPUT).
        const apart = account.provider === 'claude';
        const input = failed ? 0 : 800 + Math.floor(rand() * 6000) + (apart ? 0 : cached);
        events.push({
          at: new Date(at).toISOString(), request_id: hex(rand, 16), upstream_id: `msg_${hex(rand, 20)}`, selection_id: hex(rand, 12),
          provider: account.provider, model, auth_index: account.authIndex, stream: true, failed,
          status_code: failed ? 529 : 0, ...(failed ? { error: 'Overloaded' } : {}),
          latency_ms: 2000 + Math.floor(rand() * 30_000), ttft_ms: 400 + Math.floor(rand() * 2500),
          input_tokens: input, output_tokens: failed ? 0 : 100 + Math.floor(rand() * 3000),
          cached_tokens: cached, cache_creation_tokens: failed || !apart ? 0 : Math.floor(rand() * 4000),
          session_id: `${account.provider}:${session.id}`, user_agent: account.userAgent,
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
