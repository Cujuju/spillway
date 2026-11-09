export interface RequestSettings { thinking: string | null; thinkingBudget: number | null; maxTokens: number | null; betas: string[] }
export function parseRequestSettings(raw: unknown): RequestSettings | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const t = r.thinking && typeof r.thinking === 'object' ? r.thinking as Record<string, unknown> : null;
  const number = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
  const thinking = typeof r.thinking === 'string' ? r.thinking : typeof t?.type === 'string' ? t.type : null;
  const thinkingBudget = number(r.thinking_budget ?? t?.budget_tokens), maxTokens = number(r.max_tokens);
  const betas = Array.isArray(r.betas) ? [...new Set(r.betas.filter((v): v is string => typeof v === 'string'))].sort() : [];
  return thinking !== null || thinkingBudget !== null || maxTokens !== null || Array.isArray(r.betas) ? { thinking, thinkingBudget, maxTokens, betas } : null;
}
export function diffRequestSettings(before: RequestSettings | null, after: RequestSettings): string[] {
  const lines: string[] = [];
  for (const [key, label] of [['thinking', 'thinking'], ['thinkingBudget', 'thinking budget'], ['maxTokens', 'max tokens']] as const) {
    const a = before?.[key] ?? null, b = after[key];
    const format = (v: string | number | null) => typeof v === 'number' ? v.toLocaleString('en-US') : v ?? 'unknown';
    if (a !== b) lines.push(`${label} ${format(a)} → ${format(b)}`);
  }
  for (const beta of after.betas) if (!before?.betas.includes(beta)) lines.push(`+beta ${beta}`);
  for (const beta of before?.betas ?? []) if (!after.betas.includes(beta)) lines.push(`−beta ${beta}`);
  return lines;
}
