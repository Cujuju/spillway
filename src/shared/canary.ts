export interface CanaryTarget { model: string; effort: string }
export interface CanarySettings { enabled: boolean; intervalHours: number; targets: CanaryTarget[] }
export const CANARY_INTERVALS = [6, 12, 24] as const;
export const CANARY_MAX_TARGETS = 4;
export const DEFAULT_CANARY: CanarySettings = { enabled: false, intervalHours: 24, targets: [] };
export function normalizeCanary(raw: unknown): CanarySettings {
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const targets: CanaryTarget[] = [];
  for (const t of Array.isArray(r.targets) ? r.targets : []) {
    if (t && typeof t.model === 'string' && t.model.trim() && typeof t.effort === 'string' && t.effort.trim() && !targets.some((v) => v.model === t.model.trim() && v.effort === t.effort.trim())) targets.push({ model: t.model.trim(), effort: t.effort.trim() });
    if (targets.length === CANARY_MAX_TARGETS) break;
  }
  return { enabled: r.enabled === true, intervalHours: CANARY_INTERVALS.includes(r.intervalHours as 24) ? r.intervalHours as number : DEFAULT_CANARY.intervalHours, targets };
}
export interface CanaryProbe { id: string; version: number; title: string; prompt: string; answer: string }
const FINAL_LINE = 'Reply with your final answer on the last line as: ANSWER: <answer>';
export const CANARY_PROBES: CanaryProbe[] = [
  ['divisible', 'Divisibility', 'How many positive integers less than 1000 are divisible by 3 or by 5, but not by 15?', '400'],
  ['modpow', 'Modular power', 'What is the remainder when 7^2026 is divided by 13?', '4'],
  ['seats', 'Seating', 'Five people A, B, C, D and E sit in seats 1 to 5 in a row. A sits in seat 3. C sits next to A. E sits at one end. D does not sit at an end. B sits somewhere to the left of D. B does not sit next to E. C does not sit next to E. Who sits in seat 2? Give the letter.', 'C'],
  ['marbles', 'Probability', 'A bag holds 4 red and 6 blue balls. Two are drawn without replacement. What is the probability that both are the same colour? Give a reduced fraction like 3/8.', '7/15'],
  ['remainders', 'Remainders', 'What is the smallest positive integer that leaves remainder 2 when divided by 3, remainder 3 when divided by 5, and remainder 2 when divided by 7?', '23'],
  ['stairs', 'Stairs', 'In how many different ways can you climb a staircase of 10 steps if each move climbs either 1 or 2 steps?', '89'],
].map(([id, title, prompt, answer]) => ({ id: id!, title: title!, prompt: `${prompt}\n${FINAL_LINE}`, answer: answer!, version: 1 }));
export interface CanaryResult { id: string; batchId: string; at: string; model: string; effort: string; effectiveModel: string | null; probeId: string; probeVersion: number; outcome: 'pass' | 'fail' | 'error'; answer: string | null; error: string | null; outputTokens: number | null; thinkingTokens: number | null; latencyMs: number | null }
export interface CanaryStatus { running: boolean; lastRunAt: string | null; nextRunAt: string | null; lastError: string | null; callsPerRun: number }
