/** Fake reset grants with independent balances; never contacts a provider. */
const DAY_MS = 24 * 60 * 60 * 1000;
const GENERAL_EXPIRY_DAYS = 24;
const FABLE_EXPIRY_DAYS = 90;
const CODEX_AVAILABLE = 1;
const iso = (at: number) => new Date(at).toISOString();

export function demoResetCredits(provider: string, authIndex: string, now: number, spent: Map<string, number>) {
  if (provider === 'codex') return { available: CODEX_AVAILABLE, applicable: 0, checked_at: iso(now), expiries: [iso(now + GENERAL_EXPIRY_DAYS * DAY_MS)] };
  if (provider !== 'claude') return null;
  const grants = (['fable', 'general'] as const).map((scope) => {
    const id = `demo-${authIndex}-${scope}`;
    const available = Math.max(0, 1 - (spent.get(id) ?? 0));
    return { id, label: scope === 'fable' ? 'Fable reset' : 'Full limit reset', scope, available, applicable: available,
      expires_at: iso(now + (scope === 'fable' ? FABLE_EXPIRY_DAYS : GENERAL_EXPIRY_DAYS) * DAY_MS),
      clears: scope === 'fable' ? ['five_hour', 'seven_day_overage_included'] : ['five_hour', 'seven_day', 'seven_day_overage_included'],
      gives_back_weekly: scope === 'fable', unavailable_reason: null };
  }).filter((grant) => grant.available > 0);
  return { available: grants.reduce((sum, grant) => sum + grant.available, 0), applicable: grants.reduce((sum, grant) => sum + grant.applicable, 0),
    checked_at: iso(now), expiries: grants.map((grant) => grant.expires_at).sort(), grants };
}
