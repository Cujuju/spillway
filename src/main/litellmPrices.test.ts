import { describe, expect, it } from 'vitest';
import { catalogFromLiteLLM } from './litellmPrices';

const M = 1e-6;
/** Field names as LiteLLM's model_prices_and_context_window.json spells them. */
const FILE = {
  sample_spec: { litellm_provider: 'openai or anthropic', input_cost_per_token: 0 },
  'gpt-6.2-sol': {
    litellm_provider: 'openai', input_cost_per_token: 2 * M, output_cost_per_token: 10 * M, cache_read_input_token_cost: 0.1 * M,
    cache_creation_input_token_cost: 2.5 * M, cache_creation_input_token_cost_above_12hr: 5 * M,
    input_cost_per_token_above_272k_tokens: 4 * M, output_cost_per_token_above_272k_tokens: 15 * M, cache_read_input_token_cost_above_272k_tokens: 0.2 * M,
    cache_creation_input_token_cost_above_272k_tokens: 5 * M, cache_creation_input_token_cost_above_12hr_above_272k_tokens: 10 * M,
    input_cost_per_token_priority: 4 * M, output_cost_per_token_priority: 20 * M, cache_read_input_token_cost_priority: 0.2 * M,
    cache_creation_input_token_cost_priority: 5 * M, cache_creation_input_token_cost_above_12hr_priority: 10 * M,
    input_cost_per_token_above_272k_tokens_priority: 8 * M, output_cost_per_token_above_272k_tokens_priority: 30 * M,
    cache_read_input_token_cost_above_272k_tokens_priority: 0.4 * M, cache_creation_input_token_cost_above_272k_tokens_priority: 10 * M,
    cache_creation_input_token_cost_above_12hr_above_272k_tokens_priority: 20 * M,
  },
  'perplexity/openai/gpt-6.2-sol': { litellm_provider: 'perplexity', input_cost_per_token: 9 * M, output_cost_per_token: 9 * M },
  'claude-opus-5-5': {
    litellm_provider: 'anthropic', input_cost_per_token: 4 * M, output_cost_per_token: 20 * M, cache_read_input_token_cost: 0.2 * M,
    cache_creation_input_token_cost: 5 * M, cache_creation_input_token_cost_above_1hr: 8 * M, provider_specific_entry: { us: 1.1, fast: 2 },
  },
  'gemini/gemini-4-neon': {
    litellm_provider: 'gemini', input_cost_per_token: 3 * M, output_cost_per_token: 15 * M, cache_read_input_token_cost: 0.15 * M,
    input_cost_per_token_flex: 1.5 * M, output_cost_per_token_flex: 7.5 * M, cache_read_input_token_cost_flex: 0.075 * M,
  },
  'gpt-5-pro': { litellm_provider: 'openai', input_cost_per_token: 15 * M, output_cost_per_token: 120 * M },
  'text-embedding-9': { litellm_provider: 'openai', input_cost_per_token: 0.02 * M },
};

describe('catalogFromLiteLLM', () => {
  const catalog = catalogFromLiteLLM(FILE);

  it('keeps first-party entries only, by bare id', () => {
    expect(Object.keys(catalog).sort()).toEqual(['claude-opus-5-5', 'gemini-4-neon', 'gpt-5-pro', 'gpt-6.2-sol']);
  });

  it('reads OpenAI long-context, 12-hour writes and priority as the fast tier, in $/MTok', () => {
    expect(catalog['gpt-6.2-sol']).toEqual({
      from: null,
      rates: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWriteLong: 5 },
      longAbove: 272_000,
      long: { input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5, cacheWriteLong: 10 },
      tiers: { fast: {
        rates: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWriteLong: 10 },
        long: { input: 8, output: 30, cacheRead: 0.4, cacheWrite: 10, cacheWriteLong: 20 },
      } },
    });
  });

  it('applies Anthropic fast mode as a multiplier on every rate', () => {
    expect(catalog['claude-opus-5-5']!.rates).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWriteLong: 8 });
    expect(catalog['claude-opus-5-5']!.tiers).toEqual({ fast: { rates: { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10, cacheWriteLong: 16 } } });
  });

  it('bills unlisted cache rates as input and reads the flex tier', () => {
    expect(catalog['gemini-4-neon']!.rates).toEqual({ input: 3, output: 15, cacheRead: 0.15, cacheWrite: 3, cacheWriteLong: 3 });
    expect(catalog['gemini-4-neon']!.tiers?.flex?.rates.input).toBe(1.5);
    expect(catalog['gpt-5-pro']!.rates.cacheRead).toBe(15);
  });

  it('rejects a file that is not an object', () => {
    expect(() => catalogFromLiteLLM([])).toThrow('not an object');
  });
});

it('reads OpenAI Ultrafast rates as their own tier', () => {
  const entry = { litellm_provider: 'openai', input_cost_per_token: 2 * M, output_cost_per_token: 10 * M, input_cost_per_token_ultrafast: 12 * M, output_cost_per_token_ultrafast: 60 * M };
  expect(catalogFromLiteLLM({ 'gpt-6.1-sol': entry })['gpt-6.1-sol']!.tiers).toEqual({ ultrafast: { rates: { input: 12, output: 60, cacheRead: 12, cacheWrite: 12, cacheWriteLong: 12 } } });
});