import { describe, expect, it } from 'vitest';
import { cheapestModel, priceAt, priceTableSnapshot, promptTokens, repriceStart, reportsCacheWrites, tokenCost } from './modelPrices';

describe('price table changes', () => {
  const old = { from: null, rates: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } };
  const current = { ...old, from: '2026-10-07', rates: { ...old.rates, cacheRead: 0.1 } };
  const table = (history: unknown[]) => JSON.stringify({ model: history });
  it('ignores unchanged effective prices and redundant breakpoints', () => {
    expect(repriceStart(priceTableSnapshot(), priceTableSnapshot()).size).toBe(0);
    expect(repriceStart(table([old]), table([old, { ...old, from: current.from }])).size).toBe(0);
  });
  it('finds a later rate change', () => {
    expect([...repriceStart(table([old]), table([old, current]))]).toEqual([['model', current.from]]);
  });
  it('marks additions, removals, missing snapshots and null-entry edits for all dates', () => {
    for (const [prev, next] of [['{}', table([old])], [table([old]), '{}'], [null, table([old])], [table([old]), table([{ ...current, from: null }])]]) {
      expect([...repriceStart(prev!, next!)]).toEqual([['model', null]]);
    }
  });
});

describe('cheapestModel', () => {
  it('picks the lowest input price and skips unpriced models', () => {
    expect(cheapestModel(['claude-opus-5-5', 'claude-haiku-5-5', 'claude-unknown'])).toBe('claude-haiku-5-5');
    expect(cheapestModel(['gpt-6-sol', 'gpt-6-luna-20260101'])).toBe('gpt-6-luna-20260101');
    expect(cheapestModel(['made-up'])).toBeNull();
  });
});

const AT = '2026-10-26T12:00:00Z';
const t = (inputTokens: number, outputTokens: number, cachedTokens = 0, cacheWriteTokens = 0) => ({ inputTokens, outputTokens, cachedTokens, cacheWriteTokens });

describe('tokenCost', () => {
  it('selects rates before and on their effective UTC date', () => {
    const old = { from: null, rates: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWriteLong: 8 } };
    const current = { from: '2026-10-26', rates: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWriteLong: 4 } };
    const history = [old, current];
    expect(priceAt(history, '2026-10-25T23:59:59Z')).toBe(old);
    expect(priceAt(history, Date.parse('2026-10-26T00:00:00Z'))).toBe(current);
    expect(priceAt(history, 'not a time')).toBeNull();
  });
  it('prices Sonnet 5.5 cache reads at $0.20 before 2026-10-07 and $0.10 from then', () => {
    const reads = t(0, 0, 1_000_000);
    expect(tokenCost('claude', 'claude-sonnet-5-5', '2026-10-06T23:59:59Z', reads)!.usd).toBeCloseTo(0.2);
    expect(tokenCost('claude', 'claude-sonnet-5-5', '2026-10-07T00:00:00Z', reads)!.usd).toBeCloseTo(0.1);
  });
  it('bills Claude cache reads and writes apart from input', () => {
    // Opus 5.5: $4 in, $20 out, $0.20 read, $5 write per MTok.
    const cost = tokenCost('claude', 'claude-opus-5-5', AT, t(1_000_000, 1_000_000, 1_000_000, 1_000_000))!;
    expect(cost.usd).toBeCloseTo(4 + 20 + 0.2 + 5);
    expect(cost.uncachedUsd).toBeCloseTo(3 * 4 + 20);
  });
  it('treats OpenAI cached tokens as part of input', () => {
    // gpt-6.1-sol: $2 in, $0.10 cached, $10 out.
    const cost = tokenCost('codex', 'gpt-6.1-sol', AT, t(100_000, 0, 40_000))!;
    expect(cost.usd).toBeCloseTo(0.06 * 2 + 0.04 * 0.1);
    expect(promptTokens('codex', t(100_000, 0, 40_000))).toBe(100_000);
  });
  it('prices OpenAI prompts over 272K at the long-context rates', () => {
    expect(tokenCost('codex', 'gpt-6.1-sol', AT, t(1_000_000, 0))!.usd).toBeCloseTo(4);
  });
  it('prices a long Haiku 5.5 prompt at the higher rates, cache reads included', () => {
    const short = tokenCost('claude', 'claude-haiku-5-5', AT, t(1_000, 1_000_000, 99_000))!;
    const long = tokenCost('claude', 'claude-haiku-5-5', AT, t(1_000, 1_000_000, 100_000))!;
    expect(short.usd).toBeCloseTo(0.001 * 0.1 + 0.5 + 0.099 * 0.01);
    expect(long.usd).toBeCloseTo(0.001 * 0.5 + 2.5 + 0.1 * 0.05);
  });
  it('skips the long step for summed totals', () => {
    expect(tokenCost('claude', 'claude-haiku-5-5', AT, t(1_000_000, 0), false)!.usd).toBeCloseTo(0.1);
  });
  it('prices Fable 5.2 and Mythos 5.2', () => {
    // $8 in, $40 out, $0.20 read, $10 write per MTok.
    for (const model of ['claude-fable-5-2', 'claude-mythos-5-2']) {
      expect(tokenCost('claude', model, AT, t(1_000_000, 1_000_000, 1_000_000, 1_000_000))!.usd).toBeCloseTo(8 + 40 + 0.2 + 10);
    }
  });
  it('matches dated snapshots and returns null for unknown models', () => {
    expect(tokenCost('claude', 'claude-opus-5-5-20260901', AT, t(1_000_000, 0))!.usd).toBeCloseTo(4);
    expect(tokenCost('codex', 'gpt-image-2', AT, t(10, 10))).toBeNull();
  });
});


describe('observed billing metadata', () => {
  it('splits Claude 5-minute and 1-hour writes and bounds invalid subsets', () => {
    const tokens = { ...t(0, 0, 0, 1_000_000), cacheWrite1hTokens: 400_000 };
    expect(tokenCost('claude', 'claude-opus-5-5', AT, tokens)!.usd).toBeCloseTo(0.6 * 5 + 0.4 * 8);
    expect(tokenCost('claude', 'claude-opus-5-5', AT, { ...tokens, cacheWrite1hTokens: 2_000_000 })!.usd).toBeCloseTo(8);
    expect(tokenCost('claude', 'claude-opus-5-5', AT, { ...tokens, cacheWrite1hTokens: -1 })!.usd).toBeCloseTo(5);
  });
  it.each(['codex', 'openai'])('prices %s writes included in input, with and without a 12-hour subset', (provider) => {
    const tokens = { ...t(100_000, 0, 20_000, 40_000), cacheWriteLongTokens: null };
    expect(reportsCacheWrites(provider)).toBe(true);
    expect(promptTokens(provider, tokens)).toBe(100_000);
    expect(tokenCost(provider, 'gpt-6.1-sol', AT, tokens)!.usd).toBeCloseTo(0.04 * 2 + 0.02 * 0.1 + 0.04 * 2.5);
    expect(tokenCost(provider, 'gpt-6.1-sol', AT, { ...tokens, cacheWriteLongTokens: 10_000 })!.usd)
      .toBeCloseTo(0.04 * 2 + 0.02 * 0.1 + 0.03 * 2.5 + 0.01 * 5);
  });
  it.each(['codex', 'openai'])('prices legacy %s writes at the 30-minute rate when new fields are absent', (provider) => {
    expect(tokenCost(provider, 'gpt-6.1-sol', AT, t(100_000, 0, 20_000, 40_000))!.usd).toBeCloseTo(0.04 * 2 + 0.02 * 0.1 + 0.04 * 2.5);
  });
  it('uses Claude fast cache multipliers', () => {
    expect(tokenCost('claude', 'claude-fable-5-2', AT,
      { ...t(1_000_000, 1_000_000, 1_000_000, 1_000_000), cacheWrite1hTokens: 500_000, tier: 'fast' })!.usd)
      .toBeCloseTo(16 + 80 + 0.4 + 0.5 * 20 + 0.5 * 32);
  });
  it.each(['fast', 'flex'] as const)('selects %s rates, including long-context cache writes', (tier) => {
    const scale = tier === 'fast' ? 2 : 0.5;
    const tokens = { ...t(1_000_000, 1_000_000, 200_000, 400_000), cacheWriteLongTokens: 100_000, tier };
    expect(tokenCost('codex', 'gpt-6.1-sol', AT, tokens)!.usd).toBeCloseTo((0.4 * 4 + 15 + 0.2 * 0.2 + 0.3 * 5 + 0.1 * 10) * scale);
  });
  it('uses standard rates for absent, null, unknown and unsupported tiers', () => {
    const tokens = t(100_000, 0);
    const expected = tokenCost('codex', 'gpt-6.1-sol', AT, tokens);
    for (const tier of [undefined, null, 'standard', 'other']) {
      expect(tokenCost('codex', 'gpt-6.1-sol', AT, { ...tokens, tier } as Parameters<typeof tokenCost>[3])).toEqual(expected);
    }
    expect(tokenCost('claude', 'claude-sonnet-5-5', AT, { ...tokens, tier: 'flex' }))
      .toEqual(tokenCost('claude', 'claude-sonnet-5-5', AT, tokens));
  });
});
