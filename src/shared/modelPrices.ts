/**
 * API list prices, USD per million tokens, to estimate pay-as-you-go cost of proxied requests. Sources:
 * platform.claude.com/docs/en/about-claude/pricing, developers.openai.com/api/docs/pricing.
 */

const PER_TOKEN = 1 / 1_000_000;

interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  /** 5-minute cache write. The proxy doesn't report the write's TTL, so 1-hour writes are under-priced. */
  cacheWrite: number;
}

interface ModelPrice {
  rates: Rates;
  /** Prompts over this many tokens bill at `long` instead. */
  longAbove?: number;
  long?: Rates;
}

const r = (input: number, cacheWrite: number, cacheRead: number, output: number): Rates => ({ input, cacheWrite, cacheRead, output });
/** OpenAI requests report no cache writes, so their write rate never applies. */
const o = (input: number, cacheRead: number, output: number): Rates => r(input, input, cacheRead, output);
/** Haiku 5.5's price step (Anthropic counts cache reads and writes in the prompt). */
const HAIKU_5_5_LONG_ABOVE = 100_000;
/** OpenAI's long-context step. */
const OPENAI_LONG_ABOVE = 272_000;

const OPUS_4_5_TO_5 = { rates: r(5, 6.25, 0.5, 25) };
const OPUS_4 = { rates: r(15, 18.75, 1.5, 75) };
const SONNET_4 = { rates: r(3, 3.75, 0.3, 15) };
const FABLE_5_1 = { rates: r(10, 12.5, 0.25, 50) };
const FABLE_5 = { rates: r(10, 12.5, 1, 50) };

const PRICES: Record<string, ModelPrice> = {
  'claude-fable-5-1': FABLE_5_1,
  'claude-mythos-5-1': FABLE_5_1,
  'claude-fable-5': FABLE_5,
  'claude-mythos-5': FABLE_5,
  'claude-opus-5-5': { rates: r(4, 5, 0.2, 20) },
  'claude-opus-5': OPUS_4_5_TO_5,
  'claude-opus-4-8': OPUS_4_5_TO_5,
  'claude-opus-4-7': OPUS_4_5_TO_5,
  'claude-opus-4-6': OPUS_4_5_TO_5,
  'claude-opus-4-5': OPUS_4_5_TO_5,
  'claude-opus-4-1': OPUS_4,
  'claude-opus-4': OPUS_4,
  'claude-sonnet-5-5': { rates: r(2, 2.5, 0.1, 10) },
  'claude-sonnet-5': { rates: r(2, 2.5, 0.2, 10) },
  'claude-sonnet-4-6': SONNET_4,
  'claude-sonnet-4-5': SONNET_4,
  'claude-sonnet-4': SONNET_4,
  'claude-haiku-5-5': { rates: r(0.1, 0.125, 0.01, 0.5), longAbove: HAIKU_5_5_LONG_ABOVE, long: r(0.5, 0.625, 0.05, 2.5) },
  'claude-haiku-4-5': { rates: r(1, 1.25, 0.1, 5) },
  'gpt-6.1-sol': { rates: o(2, 0.1, 10), longAbove: OPENAI_LONG_ABOVE, long: o(4, 0.2, 15) },
  'gpt-6-sol': { rates: o(2, 0.2, 10), longAbove: OPENAI_LONG_ABOVE, long: o(4, 0.4, 15) },
  'gpt-6-luna': { rates: o(0.1, 0.01, 0.5), longAbove: OPENAI_LONG_ABOVE, long: o(0.2, 0.02, 0.75) },
  'gpt-6-astra': { rates: o(10, 1, 50), longAbove: OPENAI_LONG_ABOVE, long: o(20, 2, 75) },
  'gpt-5.6-sol': { rates: o(4, 0.4, 20), longAbove: OPENAI_LONG_ABOVE, long: o(8, 0.8, 30) },
  'gpt-5.6-terra': { rates: o(2, 0.2, 12), longAbove: OPENAI_LONG_ABOVE, long: o(4, 0.4, 18) },
  'gpt-5.6-luna': { rates: o(0.2, 0.02, 1.2), longAbove: OPENAI_LONG_ABOVE, long: o(0.4, 0.04, 1.8) },
  'gpt-5.3-codex': { rates: o(1.75, 0.175, 14) },
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

function priceOf(model: string): ModelPrice | null {
  const id = model.trim().toLowerCase();
  return PRICES[id] ?? PRICES[id.replace(DATE_SUFFIX, '')] ?? null;
}

/**
 * The model with the lowest input, then output, list price; null when none is priced. A near-empty
 * request is mostly prompt, and subscription limits weigh models roughly by price.
 */
export function cheapestModel(ids: readonly string[]): string | null {
  let best: { id: string; rates: Rates } | null = null;
  for (const id of ids) {
    const rates = priceOf(id)?.rates;
    if (!rates) continue;
    if (!best || rates.input < best.rates.input || (rates.input === best.rates.input && rates.output < best.rates.output)) best = { id, rates };
  }
  return best?.id ?? null;
}

/**
 * List-price cost of one request, or null for a model without a known price. A day's totals hide the
 * long-context step, so `long` rates are skipped.
 */
export function tokenCost(provider: string, model: string, t: TokenCounts, perRequest = true): Cost | null {
  const price = priceOf(model);
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
