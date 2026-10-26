import type { Credential, CredentialPlan, LimitWindow, UsageSnapshot } from '@shared/types';

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

/** Default account name: the part after the last "@", e.g. "pm.me". */
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

function parseCredential(raw: unknown): Credential | null {
  const c = obj(raw);
  const id = s(c.id);
  const provider = s(c.provider);
  if (!id || !provider) return null;
  const windows = Array.isArray(c.windows) ? c.windows.map(parseWindow).filter((w): w is LimitWindow => w !== null) : [];
  const note = s(c.note);
  const email = s(c.email);
  return {
    id,
    name: s(c.name) ?? id,
    authIndex: s(c.auth_index) ?? id,
    provider: provider.toLowerCase(),
    label: note ?? emailDomain(email) ?? s(c.label) ?? email ?? id,
    note,
    email,
    disabled: c.disabled === true,
    status: s(c.status) ?? 'unknown',
    statusMessage: s(c.status_message),
    priority: n(c.priority) ?? 0,
    cooldownUntil: s(c.cooldown_until),
    observedAt: s(c.observed_at),
    lastUsedAt: s(c.last_used_at),
    nextPick: c.next_pick === true,
    preferred: c.preferred === true,
    weight: n(c.weight) ?? DEFAULT_WEIGHT,
    plan: parsePlan(c.plan),
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
