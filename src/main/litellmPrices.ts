/**
 * Converts LiteLLM's public price file (model_prices_and_context_window.json) into Spillway's price shape.
 * Only first-party OpenAI, Anthropic and Gemini entries: resellers' rates are not list prices.
 */
import { CLAUDE_LONG_WRITE_MULTIPLIER, type ModelPrice, type Rates } from '@shared/modelPrices';

/** LiteLLM providers whose entries carry the provider's own list prices. */
const FIRST_PARTY = new Set(['openai', 'anthropic', 'gemini']);
const TOKENS_PER_MTOK = 1_000_000;
/** Twelve significant digits drop per-token float noise ($2.5e-6 × 1e6) without rounding any listed price. */
const PRICE_DIGITS = 12;
const LONG_INPUT = /^input_cost_per_token_above_(\d+)k_tokens$/;
const TOKENS_PER_K = 1_000;

type Entry = Record<string, unknown>;

const perMTok = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Number((value * TOKENS_PER_MTOK).toPrecision(PRICE_DIGITS)) : null;

/** Rates for one context band and tier; null when the entry lists none. Unlisted cache rates bill as input, like the bundled table. */
function ratesAt(entry: Entry, provider: string, band: string, tier: string): Rates | null {
  const field = (base: string) => perMTok(entry[`${base}${band}${tier}`]);
  const input = field('input_cost_per_token');
  const output = field('output_cost_per_token');
  if (input === null || output === null) return null;
  const longWrite = provider === 'anthropic' ? 'cache_creation_input_token_cost_above_1hr' : 'cache_creation_input_token_cost_above_12hr';
  return {
    input, output,
    cacheRead: field('cache_read_input_token_cost') ?? input,
    cacheWrite: field('cache_creation_input_token_cost') ?? input,
    cacheWriteLong: field(longWrite) ?? (provider === 'anthropic' ? input * CLAUDE_LONG_WRITE_MULTIPLIER : input),
  };
}

const scaled = (rates: Rates, factor: number): Rates =>
  Object.fromEntries(Object.entries(rates).map(([k, v]) => [k, Number((v * factor).toPrecision(PRICE_DIGITS))])) as unknown as Rates;

function modelPrice(entry: Entry, provider: string): ModelPrice | null {
  const rates = ratesAt(entry, provider, '', '');
  if (!rates) return null;
  const threshold = Object.keys(entry).map((k) => LONG_INPUT.exec(k)?.[1]).find((k) => k !== undefined);
  const band = threshold ? `_above_${threshold}k_tokens` : '';
  const long = band ? ratesAt(entry, provider, band, '') ?? undefined : undefined;
  const price: ModelPrice = { from: null, rates, ...(long ? { longAbove: Number(threshold) * TOKENS_PER_K, long } : {}) };
  const tier = (suffix: string) => {
    const tierRates = ratesAt(entry, provider, '', suffix);
    if (!tierRates) return undefined;
    const tierLong = band ? ratesAt(entry, provider, band, suffix) : null;
    return { rates: tierRates, ...(tierLong ? { long: tierLong } : {}) };
  };
  // Anthropic lists fast mode as a multiplier on every rate.
  const multiplier = (entry.provider_specific_entry as { fast?: unknown } | undefined)?.fast;
  const fast = provider === 'anthropic'
    ? typeof multiplier === 'number' && multiplier > 0 ? { rates: scaled(rates, multiplier), ...(long ? { long: scaled(long, multiplier) } : {}) } : undefined
    : tier('_priority');
  const flex = tier('_flex');
  if (fast || flex) price.tiers = { ...(fast ? { fast } : {}), ...(flex ? { flex } : {}) };
  return price;
}

/** First-party models by bare id ("gemini/gemini-4-neon" → "gemini-4-neon"); a bare key wins over a prefixed duplicate. */
export function catalogFromLiteLLM(file: unknown): Record<string, ModelPrice> {
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error('LiteLLM price file is not an object');
  const out: Record<string, ModelPrice> = {};
  const bare = new Set<string>();
  for (const [key, value] of Object.entries(file as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Entry;
    const provider = entry.litellm_provider;
    if (typeof provider !== 'string' || !FIRST_PARTY.has(provider)) continue;
    const prefixed = key.startsWith(`${provider}/`);
    const id = (prefixed ? key.slice(provider.length + 1) : key).trim().toLowerCase();
    if (id.includes('/') || (prefixed && bare.has(id))) continue;
    const price = modelPrice(entry, provider);
    if (!price) continue;
    out[id] = price;
    if (!prefixed) bare.add(id);
  }
  return out;
}
