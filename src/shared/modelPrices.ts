/**
 * API list prices, USD per million tokens, to estimate pay-as-you-go cost of proxied requests. Sources:
 * platform.claude.com/docs/en/about-claude/pricing, developers.openai.com/api/docs/pricing.
 */

const PER_TOKEN = 1 / 1_000_000;

export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  /** 5-minute cache write. The proxy doesn't report the write's TTL, so 1-hour writes are under-priced. */
  cacheWrite: number;
}

interface ModelPrice {
  from: string | null;
  rates: Rates;
  /** Prompts over this many tokens bill at `long` instead. */
  longAbove?: number;
  long?: Rates;
}

const r = (input: number, cacheWrite: number, cacheRead: number, output: number): Rates => ({ input, cacheWrite, cacheRead, output });
/** OpenAI requests report no cache writes, so their write rate never applies. */
const o = (input: number, cacheRead: number, output: number): Rates => r(input, input, cacheRead, output);
/** OpenAI models without prompt caching ("-" on the page): any cached tokens bill as input. */
const noCache = (input: number, output: number): Rates => o(input, input, output);
/** Haiku 5.5's price step (Anthropic counts cache reads and writes in the prompt). */
const HAIKU_5_5_LONG_ABOVE = 100_000;
/** OpenAI's long-context step. */
const OPENAI_LONG_ABOVE = 272_000;

const OPUS_4_5_TO_5 = [{ from: null, rates: r(5, 6.25, 0.5, 25) }];
const OPUS_4 = [{ from: null, rates: r(15, 18.75, 1.5, 75) }];
const SONNET_4 = [{ from: null, rates: r(3, 3.75, 0.3, 15) }];
const FABLE_5_2 = [{ from: null, rates: r(8, 10, 0.2, 40) }];
const FABLE_5_1 = [{ from: null, rates: r(10, 12.5, 0.25, 50) }];
const FABLE_5 = [{ from: null, rates: r(10, 12.5, 1, 50) }];

const PRICES: Record<string, readonly ModelPrice[]> = {
  'claude-fable-5-2': FABLE_5_2,
  'claude-mythos-5-2': FABLE_5_2,
  'claude-fable-5-1': FABLE_5_1,
  'claude-mythos-5-1': FABLE_5_1,
  'claude-fable-5': FABLE_5,
  'claude-mythos-5': FABLE_5,
  'claude-opus-5-5': [{ from: null, rates: r(4, 5, 0.2, 20) }],
  'claude-opus-5': OPUS_4_5_TO_5,
  'claude-opus-4-8': OPUS_4_5_TO_5,
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
  'gpt-6.1-sol': [{ from: null, rates: o(2, 0.1, 10), longAbove: OPENAI_LONG_ABOVE, long: o(4, 0.2, 15) }],
  'gpt-6-sol': [{ from: null, rates: o(2, 0.2, 10), longAbove: OPENAI_LONG_ABOVE, long: o(4, 0.4, 15) }],
  'gpt-6-luna': [{ from: null, rates: o(0.1, 0.01, 0.5), longAbove: OPENAI_LONG_ABOVE, long: o(0.2, 0.02, 0.75) }],
  'gpt-6-astra': [{ from: null, rates: o(10, 1, 50), longAbove: OPENAI_LONG_ABOVE, long: o(20, 2, 75) }],
  'gpt-5.6-sol': [{ from: null, rates: o(4, 0.4, 20), longAbove: OPENAI_LONG_ABOVE, long: o(8, 0.8, 30) }],
  'gpt-5.6-terra': [{ from: null, rates: o(2, 0.2, 12), longAbove: OPENAI_LONG_ABOVE, long: o(4, 0.4, 18) }],
  'gpt-5.6-luna': [{ from: null, rates: o(0.2, 0.02, 1.2), longAbove: OPENAI_LONG_ABOVE, long: o(0.4, 0.04, 1.8) }],
  'gpt-5.3-codex': [{ from: null, rates: o(1.75, 0.175, 14) }],
  'gpt-6.1-terra': [{ from: null, rates: o(1, 0.05, 5), longAbove: OPENAI_LONG_ABOVE, long: o(2, 0.1, 7.5) }],
  'gpt-5.5': [{ from: null, rates: o(5, 0.5, 30), longAbove: OPENAI_LONG_ABOVE, long: o(10, 1, 45) }],
  'gpt-5.5-pro': [{ from: null, rates: noCache(30, 180), longAbove: OPENAI_LONG_ABOVE, long: noCache(60, 270) }],
  'gpt-5.4': [{ from: null, rates: o(2.5, 0.25, 15), longAbove: OPENAI_LONG_ABOVE, long: o(5, 0.5, 22.5) }],
  'gpt-5.4-pro': [{ from: null, rates: noCache(30, 180), longAbove: OPENAI_LONG_ABOVE, long: noCache(60, 270) }],
  'gpt-5.4-mini': [{ from: null, rates: o(0.75, 0.075, 4.5) }],
  'gpt-5.4-nano': [{ from: null, rates: o(0.2, 0.02, 1.25) }],
  'gpt-5.2': [{ from: null, rates: o(1.75, 0.175, 14) }],
  'gpt-5.2-pro': [{ from: null, rates: noCache(21, 168) }],
  'gpt-5.1': [{ from: null, rates: o(1.25, 0.125, 10) }],
  'gpt-5': [{ from: null, rates: o(1.25, 0.125, 10) }],
  'gpt-5-mini': [{ from: null, rates: o(0.25, 0.025, 2) }],
  'gpt-5-nano': [{ from: null, rates: o(0.05, 0.005, 0.4) }],
  'gpt-5-pro': [{ from: null, rates: noCache(15, 120) }],
  'gpt-4.1': [{ from: null, rates: o(2, 0.5, 8) }],
  'gpt-4.1-mini': [{ from: null, rates: o(0.4, 0.1, 1.6) }],
  'gpt-4o': [{ from: null, rates: o(2.5, 1.25, 10) }],
  'gpt-4o-mini': [{ from: null, rates: o(0.15, 0.075, 0.6) }],
  'o3-pro': [{ from: null, rates: noCache(20, 80) }],
  'o3': [{ from: null, rates: o(2, 0.5, 8) }],
};

/** Claude bills cache reads and writes apart from input; OpenAI's input includes its cached tokens. */
const CACHE_APART_FROM_INPUT = new Set(['claude']);
/** Providers whose usage reports cache writes; OpenAI's reports none. */
const CACHE_WRITES_REPORTED = new Set(['claude']);
export const reportsCacheWrites = (provider: string) => CACHE_WRITES_REPORTED.has(provider);

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
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
  const rates = perRequest && price.long && prompt > price.longAbove! ? price.long : price.rates;
  const apart = CACHE_APART_FROM_INPUT.has(provider);
  const uncachedInput = apart ? t.inputTokens : Math.max(0, t.inputTokens - t.cachedTokens);
  const writes = apart ? t.cacheWriteTokens : 0;
  const usd = (uncachedInput * rates.input + t.cachedTokens * rates.cacheRead + writes * rates.cacheWrite + t.outputTokens * rates.output) * PER_TOKEN;
  const uncachedUsd = (prompt * rates.input + t.outputTokens * rates.output) * PER_TOKEN;
  return { usd, uncachedUsd };
}
