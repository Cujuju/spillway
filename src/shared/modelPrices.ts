/**
 * API list prices, USD per million tokens, to estimate pay-as-you-go cost of proxied requests. Sources:
 * platform.claude.com/docs/en/about-claude/pricing, developers.openai.com/api/docs/pricing.
 */

const PER_TOKEN = 1 / 1_000_000;

export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  /** Claude 5-minute or OpenAI 30-minute cache write. */
  cacheWrite: number;
  /** Claude 1-hour or OpenAI 12-hour cache write. */
  cacheWriteLong: number;
}

export interface TierPrice { rates: Rates; long?: Rates }

interface ModelPrice {
  from: string | null;
  rates: Rates;
  /** Prompts over this many tokens bill at `long` instead. */
  longAbove?: number;
  long?: Rates;
  tiers?: { fast?: TierPrice; flex?: TierPrice };
}

/** Anthropic pricing: 1-hour writes cost twice base input. */
const CLAUDE_LONG_WRITE_MULTIPLIER = 2;
const r = (input: number, cacheWrite: number, cacheRead: number, output: number): Rates =>
  ({ input, cacheWrite, cacheWriteLong: input * CLAUDE_LONG_WRITE_MULTIPLIER, cacheRead, output });
/** Unlisted cache-write rates retain input pricing. */
const o = (input: number, cacheRead: number, output: number, cacheWrite = input, cacheWriteLong = input): Rates =>
  ({ input, cacheRead, output, cacheWrite, cacheWriteLong });
/** OpenAI models without prompt caching bill any cached tokens as input. */
const noCache = (input: number, output: number): Rates => o(input, input, output);
/** Haiku 5.5's price step (Anthropic counts cache reads and writes in the prompt). */
const HAIKU_5_5_LONG_ABOVE = 100_000;
/** OpenAI's long-context step. */
const OPENAI_LONG_ABOVE = 272_000;

const OPUS_4_5_TO_5 = [{ from: null, rates: r(5, 6.25, 0.5, 25) }];
const OPUS_4 = [{ from: null, rates: r(15, 18.75, 1.5, 75) }];
const SONNET_4 = [{ from: null, rates: r(3, 3.75, 0.3, 15) }];
const FABLE_5_2 = [{ from: null, rates: r(8, 10, 0.2, 40), tiers: { fast: { rates: r(16, 20, 0.4, 80) } } }];
const FABLE_5_1 = [{ from: null, rates: r(10, 12.5, 0.25, 50) }];
const FABLE_5 = [{ from: null, rates: r(10, 12.5, 1, 50) }];

const PRICES: Record<string, readonly ModelPrice[]> = {
  'claude-fable-5-2': FABLE_5_2,
  'claude-mythos-5-2': FABLE_5_2,
  'claude-fable-5-1': FABLE_5_1,
  'claude-mythos-5-1': FABLE_5_1,
  'claude-fable-5': FABLE_5,
  'claude-mythos-5': FABLE_5,
  'claude-opus-5-5': [{ from: null, rates: r(4, 5, 0.2, 20), tiers: { fast: { rates: r(8, 10, 0.4, 40) } } }],
  'claude-opus-5': [{ ...OPUS_4_5_TO_5[0]!, tiers: { fast: { rates: r(10, 12.5, 1, 50) } } }],
  'claude-opus-4-8': [{ ...OPUS_4_5_TO_5[0]!, tiers: { fast: { rates: r(10, 12.5, 1, 50) } } }],
  'claude-opus-4-7': OPUS_4_5_TO_5,
  'claude-opus-4-6': OPUS_4_5_TO_5,
  'claude-opus-4-5': OPUS_4_5_TO_5,
  'claude-opus-4-1': OPUS_4,
  'claude-opus-4': OPUS_4,
  /** Cache reads halved when Haiku 5.5 launched. */
  'claude-sonnet-5-5': [{ from: null, rates: r(2, 2.5, 0.2, 10) }, { from: '2026-10-07', rates: r(2, 2.5, 0.1, 10) }],
  'claude-sonnet-5': [{ from: null, rates: r(2, 2.5, 0.2, 10) }],
  'claude-sonnet-4-6': SONNET_4,
  'claude-sonnet-4-5': SONNET_4,
  'claude-sonnet-4': SONNET_4,
  'claude-haiku-5-5': [{ from: null, rates: r(0.1, 0.125, 0.01, 0.5), longAbove: HAIKU_5_5_LONG_ABOVE, long: r(0.5, 0.625, 0.05, 2.5) }],
  'claude-haiku-4-5': [{ from: null, rates: r(1, 1.25, 0.1, 5) }],
  'gpt-6.1-sol': [{ from: null, rates: o(2, 0.1, 10, 2.5, 5), longAbove: OPENAI_LONG_ABOVE, long: o(4, 0.2, 15, 5, 10), tiers: { fast: { rates: o(4, 0.2, 20, 5, 10), long: o(8, 0.4, 30, 10, 20) }, flex: { rates: o(1, 0.05, 5, 1.25, 2.5), long: o(2, 0.1, 7.5, 2.5, 5) } } }],
  'gpt-6-sol': [{ from: null, rates: o(2, 0.2, 10, 2.5, 5), longAbove: OPENAI_LONG_ABOVE, long: o(4, 0.4, 15, 5, 10), tiers: { fast: { rates: o(4, 0.4, 20, 5, 10), long: o(8, 0.8, 30, 10, 20) }, flex: { rates: o(1, 0.1, 5, 1.25, 2.5), long: o(2, 0.2, 7.5, 2.5, 5) } } }],
  'gpt-6-luna': [{ from: null, rates: o(0.1, 0.01, 0.5, 0.125, 0.25), longAbove: OPENAI_LONG_ABOVE, long: o(0.2, 0.02, 0.75, 0.25, 0.5), tiers: { fast: { rates: o(0.2, 0.02, 1, 0.25, 0.5), long: o(0.4, 0.04, 1.5, 0.5, 1) }, flex: { rates: o(0.05, 0.005, 0.25, 0.0625, 0.125), long: o(0.1, 0.01, 0.375, 0.125, 0.25) } } }],
  'gpt-6-astra': [{ from: null, rates: o(10, 1, 50, 12.5, 25), longAbove: OPENAI_LONG_ABOVE, long: o(20, 2, 75, 25, 50), tiers: { fast: { rates: o(20, 2, 100, 25, 50), long: o(40, 4, 150, 50, 100) }, flex: { rates: o(5, 0.5, 25, 6.25, 12.5), long: o(10, 1, 37.5, 12.5, 25) } } }],
  'gpt-5.6-sol': [{ from: null, rates: o(4, 0.4, 20, 5, 10), longAbove: OPENAI_LONG_ABOVE, long: o(8, 0.8, 30, 10, 20), tiers: { fast: { rates: o(8, 0.8, 40, 10, 20), long: o(16, 1.6, 60, 20, 40) }, flex: { rates: o(2, 0.2, 10, 2.5, 5), long: o(4, 0.4, 15, 5, 10) } } }],
  'gpt-5.6-terra': [{ from: null, rates: o(2, 0.2, 12, 2.5, 5), longAbove: OPENAI_LONG_ABOVE, long: o(4, 0.4, 18, 5, 10), tiers: { fast: { rates: o(4, 0.4, 24, 5, 10), long: o(8, 0.8, 36, 10, 20) }, flex: { rates: o(1, 0.1, 6, 1.25, 2.5), long: o(2, 0.2, 9, 2.5, 5) } } }],
  'gpt-5.6-luna': [{ from: null, rates: o(0.2, 0.02, 1.2, 0.25, 0.5), longAbove: OPENAI_LONG_ABOVE, long: o(0.4, 0.04, 1.8, 0.5, 1), tiers: { fast: { rates: o(0.4, 0.04, 2.4, 0.5, 1), long: o(0.8, 0.08, 3.6, 1, 2) }, flex: { rates: o(0.1, 0.01, 0.6, 0.125, 0.25), long: o(0.2, 0.02, 0.9, 0.25, 0.5) } } }],
  'gpt-5.3-codex': [{ from: null, rates: o(1.75, 0.175, 14) }],
  'gpt-6.1-terra': [{ from: null, rates: o(1, 0.05, 5, 1.25, 2.5), longAbove: OPENAI_LONG_ABOVE, long: o(2, 0.1, 7.5, 2.5, 5), tiers: { fast: { rates: o(2, 0.1, 10, 2.5, 5), long: o(4, 0.2, 15, 5, 10) }, flex: { rates: o(0.5, 0.025, 2.5, 0.625, 1.25), long: o(1, 0.05, 3.75, 1.25, 2.5) } } }],
  'gpt-5.5': [{ from: null, rates: o(5, 0.5, 30, 5, 5), longAbove: OPENAI_LONG_ABOVE, long: o(10, 1, 45, 10, 10), tiers: { fast: { rates: o(12.5, 1.25, 75, 12.5, 12.5) }, flex: { rates: o(2.5, 0.25, 15, 2.5, 2.5), long: o(5, 0.5, 22.5, 5, 5) } } }],
  'gpt-5.5-pro': [{ from: null, rates: noCache(30, 180), longAbove: OPENAI_LONG_ABOVE, long: noCache(60, 270), tiers: { flex: { rates: noCache(15, 90) } } }],
  'gpt-5.4': [{ from: null, rates: o(2.5, 0.25, 15, 2.5, 2.5), longAbove: OPENAI_LONG_ABOVE, long: o(5, 0.5, 22.5, 5, 5), tiers: { fast: { rates: o(5, 0.5, 30, 5, 5) }, flex: { rates: o(1.25, 0.13, 7.5, 1.25, 1.25), long: o(2.5, 0.25, 11.25, 2.5, 2.5) } } }],
  'gpt-5.4-pro': [{ from: null, rates: noCache(30, 180), longAbove: OPENAI_LONG_ABOVE, long: noCache(60, 270), tiers: { flex: { rates: noCache(15, 90), long: noCache(30, 135) } } }],
  'gpt-5.4-mini': [{ from: null, rates: o(0.75, 0.075, 4.5, 0.75, 0.75), tiers: { fast: { rates: o(1.5, 0.15, 9, 1.5, 1.5) }, flex: { rates: o(0.375, 0.0375, 2.25, 0.375, 0.375) } } }],
  'gpt-5.4-nano': [{ from: null, rates: o(0.2, 0.02, 1.25, 0.2, 0.2), tiers: { flex: { rates: o(0.1, 0.01, 0.625, 0.1, 0.1) } } }],
  'gpt-5.2': [{ from: null, rates: o(1.75, 0.175, 14, 1.75, 1.75), tiers: { fast: { rates: o(3.5, 0.35, 28, 3.5, 3.5) }, flex: { rates: o(0.875, 0.0875, 7, 0.875, 0.875) } } }],
  'gpt-5.2-pro': [{ from: null, rates: noCache(21, 168) }],
  'gpt-5.1': [{ from: null, rates: o(1.25, 0.125, 10, 1.25, 1.25), tiers: { fast: { rates: o(2.5, 0.25, 20, 2.5, 2.5) }, flex: { rates: o(0.625, 0.0625, 5, 0.625, 0.625) } } }],
  'gpt-5': [{ from: null, rates: o(1.25, 0.125, 10, 1.25, 1.25), tiers: { fast: { rates: o(2.5, 0.25, 20, 2.5, 2.5) }, flex: { rates: o(0.625, 0.0625, 5, 0.625, 0.625) } } }],
  'gpt-5-mini': [{ from: null, rates: o(0.25, 0.025, 2, 0.25, 0.25), tiers: { fast: { rates: o(0.45, 0.045, 3.6, 0.45, 0.45) }, flex: { rates: o(0.125, 0.0125, 1, 0.125, 0.125) } } }],
  'gpt-5-nano': [{ from: null, rates: o(0.05, 0.005, 0.4, 0.05, 0.05), tiers: { flex: { rates: o(0.025, 0.0025, 0.2, 0.025, 0.025) } } }],
  'gpt-5-pro': [{ from: null, rates: noCache(15, 120) }],
  'gpt-4.1': [{ from: null, rates: o(2, 0.5, 8, 2, 2), tiers: { fast: { rates: o(3.5, 0.875, 14, 3.5, 3.5) } } }],
  'gpt-4.1-mini': [{ from: null, rates: o(0.4, 0.1, 1.6, 0.4, 0.4), tiers: { fast: { rates: o(0.7, 0.175, 2.8, 0.7, 0.7) } } }],
  'gpt-4o': [{ from: null, rates: o(2.5, 1.25, 10, 2.5, 2.5), tiers: { fast: { rates: o(4.25, 2.125, 17, 4.25, 4.25) } } }],
  'gpt-4o-mini': [{ from: null, rates: o(0.15, 0.075, 0.6, 0.15, 0.15), tiers: { fast: { rates: o(0.25, 0.125, 1, 0.25, 0.25) } } }],
  'o3-pro': [{ from: null, rates: noCache(20, 80) }],
  'o3': [{ from: null, rates: o(2, 0.5, 8, 2, 2), tiers: { fast: { rates: o(3.5, 0.875, 14, 3.5, 3.5) }, flex: { rates: o(1, 0.25, 4, 1, 1) } } }],
};

/** Claude bills cache reads and writes apart from input; OpenAI's input includes its cached tokens. */
const CACHE_APART_FROM_INPUT = new Set(['claude']);
/** Providers whose usage reports cache writes. */
const CACHE_WRITES_REPORTED = new Set(['claude', 'codex', 'openai']);
export const reportsCacheWrites = (provider: string) => CACHE_WRITES_REPORTED.has(provider);

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens?: number | null;
  cacheWriteLongTokens?: number | null;
  tier?: 'standard' | 'fast' | 'flex' | null;
}

/** Prompt tokens of a request or total: what the model read, cached or not. */
export function promptTokens(provider: string, t: TokenCounts): number {
  return CACHE_APART_FROM_INPUT.has(provider) ? t.inputTokens + t.cachedTokens + t.cacheWriteTokens : t.inputTokens;
}

export interface Cost {
  /** Estimated list-price cost. */
  usd: number;
  /** The same tokens with every prompt token billed at the uncached input rate. */
  uncachedUsd: number;
}

/** Dated snapshot ids ("…-20260401") price like their model. */
const DATE_SUFFIX = /-\d{8}$/;

const stableJson = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : v);
const PRICE_TABLE_SNAPSHOT = stableJson(PRICES);

/** Full dated table, independent of object insertion order. */
export const priceTableSnapshot = (): string => PRICE_TABLE_SNAPSHOT;

/** Earliest breakpoint at which effective rates differ; redundant history entries do not count. */
export function repriceStart(prev: string | null, next: string): Map<string, string | null> {
  const before = JSON.parse(prev ?? '{}') as typeof PRICES;
  const after = JSON.parse(next) as typeof PRICES;
  const changed = new Map<string, string | null>();
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[id], b = after[id];
    if (prev === null || !a || !b) { changed.set(id, null); continue; }
    const dates = new Set([null, ...a.map((p) => p.from), ...b.map((p) => p.from)]);
    const effective = (history: readonly ModelPrice[], day: string | null) => {
      const price = history.findLast((p) => p.from === null || day !== null && p.from <= day);
      if (!price) return null;
      const { from: _, ...rates } = price;
      return stableJson(rates);
    };
    for (const day of [...dates].sort((a, b) => a === null ? -1 : b === null ? 1 : a.localeCompare(b))) {
      if (effective(a, day) !== effective(b, day)) { changed.set(id, day); break; }
    }
  }
  return changed;
}

function priceHistory(model: string): readonly ModelPrice[] | null {
  const id = model.trim().toLowerCase();
  return PRICES[id] ?? PRICES[id.replace(DATE_SUFFIX, '')] ?? null;
}

/** Rates in effect on the request's UTC date; histories are oldest first. An unreadable time is unpriced. */
export function priceAt(history: readonly ModelPrice[], at: string | number): ModelPrice | null {
  const time = new Date(at);
  if (Number.isNaN(time.getTime())) return null;
  const day = time.toISOString().split('T')[0]!;
  return history.findLast((price) => price.from === null || price.from <= day) ?? null;
}

/** Each priced model's current rates, for the price check script. */
export const latestPrices = (): Map<string, ModelPrice> => new Map(Object.entries(PRICES).map(([id, history]) => [id, history.at(-1)!]));

/**
 * The model with the lowest input, then output, list price; null when none is priced. A near-empty
 * request is mostly prompt, and subscription limits weigh models roughly by price.
 */
export function cheapestModel(ids: readonly string[]): string | null {
  let best: { id: string; rates: Rates } | null = null;
  for (const id of ids) {
    const rates = priceHistory(id)?.at(-1)?.rates;
    if (!rates) continue;
    if (!best || rates.input < best.rates.input || (rates.input === best.rates.input && rates.output < best.rates.output)) best = { id, rates };
  }
  return best?.id ?? null;
}

/**
 * List-price cost of one request, or null for a model without a known price. A day's totals hide the
 * long-context step, so `long` rates are skipped.
 */
export function tokenCost(provider: string, model: string, at: string | number, t: TokenCounts, perRequest = true): Cost | null {
  const history = priceHistory(model);
  const price = history ? priceAt(history, at) : null;
  if (!price) return null;
  const prompt = promptTokens(provider, t);
  // Unknown or unlisted tiers use standard rates.
  const tier = t.tier === 'fast' || t.tier === 'flex' ? price.tiers?.[t.tier] : undefined;
  const selected = tier ?? price;
  const rates = perRequest && selected.long && prompt > price.longAbove! ? selected.long : selected.rates;
  const apart = CACHE_APART_FROM_INPUT.has(provider);
  const writes = reportsCacheWrites(provider) ? Math.max(0, t.cacheWriteTokens) : 0;
  const longWrites = Math.min(writes, Math.max(0, (apart ? t.cacheWrite1hTokens : t.cacheWriteLongTokens) ?? 0));
  const uncachedInput = apart ? t.inputTokens : Math.max(0, t.inputTokens - t.cachedTokens - writes);
  const usd = (uncachedInput * rates.input + t.cachedTokens * rates.cacheRead + (writes - longWrites) * rates.cacheWrite + longWrites * rates.cacheWriteLong + t.outputTokens * rates.output) * PER_TOKEN;
  const uncachedUsd = (prompt * rates.input + t.outputTokens * rates.output) * PER_TOKEN;
  return { usd, uncachedUsd };
}
