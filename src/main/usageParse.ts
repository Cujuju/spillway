import type { Credential, CredentialPlan, LimitWindow, ResetCreditGrant, ResetCredits, UsageSnapshot } from '@shared/types';

/** Maps the proxy's snake_case /usage/windows payload to the app's types, dropping malformed entries. */

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const s = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const STATUSES = ['allowed', 'allowed_warning', 'rejected'] as const;
const CADENCES = ['fixed', 'on_use'] as const;
/** The proxy's weight for credentials that set none (credentialweight.Default). */
const DEFAULT_WEIGHT = 1;
const MS_PER_SECOND = 1000;
const HOUR_MS = 3_600_000;

/** Proxies older than duration_seconds: infer the length from the key the proxy assigns. */
function legacyDurationMs(key: string): number | null {
  const k = key.toLowerCase();
  if (/five_hour|5h|primary/.test(k)) return 5 * HOUR_MS;
  if (/daily|day_1|24h/.test(k)) return 24 * HOUR_MS;
  if (/seven_day|weekly|7d|secondary/.test(k)) return 7 * 24 * HOUR_MS;
  if (/month/.test(k)) return 30 * 24 * HOUR_MS;
  return null;
}

function parseWindow(raw: unknown): LimitWindow | null {
  const w = obj(raw);
  const key = s(w.key);
  if (!key) return null;
  const status = STATUSES.find((st) => st === w.status) ?? null;
  const seconds = n(w.duration_seconds);
  return {
    key,
    label: s(w.label) ?? key,
    usedPercent: n(w.used_percent),
    resetsAt: s(w.resets_at),
    status,
    durationMs: 'duration_seconds' in w ? (seconds && seconds > 0 ? seconds * MS_PER_SECOND : null) : legacyDurationMs(key),
    scoped: w.scoped === true,
    resetCadence: CADENCES.find((c) => c === w.reset_cadence) ?? null,
  };
}

/** The proxy's key for Claude's pay-as-you-go limit (`Anthropic-Ratelimit-Unified-Overage-*`). */
const CLAUDE_OVERAGE_KEY = 'overage';

/**
 * Overage reasons meaning pay-as-you-go is on but ran out. Not `org_level_disabled_until`: accounts
 * without extra usage send it on every response (anthropics/claude-code#104690).
 */
const CLAUDE_OVERAGE_LIMIT_REASONS: ReadonlySet<string> = new Set(['org_spend_cap_reached', 'out_of_credits']);

/**
 * A status-only `rejected` overage window means pay-as-you-go is off. Usage, a reset or a limit
 * reason means it is on, so it stays. Older proxies send no reason.
 */
const isDisabledOverage = (provider: string, w: LimitWindow, disabledReason: string | null): boolean =>
  provider === 'claude' && w.key === CLAUDE_OVERAGE_KEY && w.status === 'rejected' && w.usedPercent === null && w.resetsAt === null
  && !(disabledReason !== null && CLAUDE_OVERAGE_LIMIT_REASONS.has(disabledReason));

/** Default account name: the part after the last "@", e.g. "example.com". */
export function emailDomain(email: string | null): string | null {
  const at = email?.lastIndexOf('@') ?? -1;
  return email && at >= 0 ? s(email.slice(at + 1)) : null;
}

function parsePlan(raw: unknown): CredentialPlan | null {
  const p = obj(raw);
  const tier = s(p.tier) ?? '';
  const label = s(p.label) ?? tier;
  if (!label) return null;
  const multiplier = n(p.multiplier);
  return { tier, label, multiplier: multiplier !== null && multiplier > 0 ? multiplier : null };
}

function parseResetGrant(raw: unknown): ResetCreditGrant | null {
  const g = obj(raw);
  const id = s(g.id);
  const available = n(g.available);
  if (!id || available === null || available < 0 || !Number.isInteger(available)) return null;
  const scope = g.scope === 'fable' || g.scope === 'general' ? g.scope : 'unknown';
  const expiry = s(g.expires_at);
  const validExpiry = g.expires_at === null || (expiry !== null && Number.isFinite(Date.parse(expiry)));
  const applicable = Math.min(available, Math.max(0, Math.floor(n(g.applicable) ?? 0)));
  return {
    id, label: s(g.label) ?? id, scope, available,
    applicable: scope !== 'unknown' && validExpiry ? applicable : 0,
    expiresAt: validExpiry ? expiry : null,
    clears: (Array.isArray(g.clears) ? g.clears : []).filter((key): key is string => typeof key === 'string'),
    givesBackWeekly: typeof g.gives_back_weekly === 'boolean' ? g.gives_back_weekly : null,
    unavailableReason: validExpiry ? s(g.unavailable_reason) : 'Invalid reset expiry',
  };
}

function parseResetCredits(raw: unknown): ResetCredits | null {
  const r = obj(raw);
  const available = n(r.available);
  const checkedAt = s(r.checked_at);
  if (available === null || available < 0 || !checkedAt) return null;
  const expiries = (Array.isArray(r.expiries) ? r.expiries : [])
    .map(s)
    .filter((t): t is string => t !== null && !Number.isNaN(Date.parse(t)))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  const grants = 'grants' in r
    ? (Array.isArray(r.grants) ? r.grants : []).map(parseResetGrant).filter((g): g is ResetCreditGrant => g !== null)
    : undefined;
  return { available, applicable: Math.min(available, Math.max(0, n(r.applicable) ?? 0)), checkedAt, expiries,
    ...(grants === undefined ? {} : { grants }) };
}

/** The proxy keeps a provider's raw error body; show its message, e.g. `{"error":{"message":"…"}}` → "…". */
export function errorText(raw: unknown): string | null {
  const text = s(raw);
  if (!text?.trimStart().startsWith('{')) return text;
  let body: Obj;
  try {
    body = obj(JSON.parse(text));
  } catch {
    return text;
  }
  const error = obj(body.error);
  return s(error.message) ?? s(body.error) ?? s(body.message) ?? s(body.detail) ?? text;
}

function parseCredential(raw: unknown): Credential | null {
  const c = obj(raw);
  const id = s(c.id);
  const provider = s(c.provider)?.toLowerCase();
  if (!id || !provider) return null;
  const windows = (Array.isArray(c.windows) ? c.windows : []).flatMap((raw: unknown) => {
    const w = parseWindow(raw);
    return w && !isDisabledOverage(provider, w, s(obj(raw).disabled_reason)) ? [w] : [];
  });
  const note = s(c.note);
  const email = s(c.email);
  const key = obj(c.api_key);
  const masked = s(key.masked);
  const apiKey = masked ? { masked, success: Math.max(0, n(key.success) ?? 0), failed: Math.max(0, n(key.failed) ?? 0) } : null;
  const disabled = c.disabled === true;
  return {
    id,
    name: s(c.name) ?? id,
    authIndex: s(c.auth_index) ?? id,
    provider,
    // The proxy labels every key of a family alike ("claude-apikey"); the masked key tells them apart.
    label: note ?? masked ?? emailDomain(email) ?? s(c.label) ?? email ?? id,
    note,
    email,
    apiKey,
    disabled,
    canRefresh: typeof c.can_refresh === 'boolean' ? c.can_refresh
      : !apiKey && !disabled && (provider === 'claude' || provider === 'codex'),
    status: s(c.status) ?? 'unknown',
    statusMessage: errorText(c.status_message),
    priority: n(c.priority) ?? 0,
    cooldownUntil: s(c.cooldown_until),
    observedAt: s(c.observed_at),
    lastUsedAt: s(c.last_used_at),
    nextPick: c.next_pick === true,
    preferred: c.preferred === true,
    weight: n(c.weight) ?? DEFAULT_WEIGHT,
    plan: parsePlan(c.plan),
    resetCredits: parseResetCredits(c.reset_credits),
    windows,
  };
}

/** Appends 1, 2, … to labels shared within a provider, numbered in id order so numbers stay put between polls. */
function numberDuplicateLabels(creds: Credential[]): Credential[] {
  const key = (c: Credential) => `${c.provider}\n${c.label}`;
  const counts = new Map<string, number>();
  for (const c of creds) counts.set(key(c), (counts.get(key(c)) ?? 0) + 1);
  const taken = new Map<string, number>();
  const numbered = new Map<string, string>();
  for (const c of [...creds].sort((a, b) => a.id.localeCompare(b.id))) {
    if (counts.get(key(c))! < 2) continue;
    const n = (taken.get(key(c)) ?? 0) + 1;
    taken.set(key(c), n);
    numbered.set(c.id, `${c.label} ${n}`);
  }
  return creds.map((c) => (numbered.has(c.id) ? { ...c, label: numbered.get(c.id)! } : c));
}

export function parseUsageSnapshot(raw: unknown): UsageSnapshot {
  const r = obj(raw);
  const credentials = Array.isArray(r.credentials)
    ? numberDuplicateLabels(r.credentials.map(parseCredential).filter((c): c is Credential => c !== null))
    : [];
  return { fetchedAt: new Date().toISOString(), strategy: s(r.strategy) ?? 'unknown', credentials };
}
