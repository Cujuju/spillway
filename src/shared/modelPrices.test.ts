import { describe, expect, it } from 'vitest';
import { cheapestModel, promptTokens, tokenCost } from './modelPrices';

describe('cheapestModel', () => {
  it('picks the lowest input price and skips unpriced models', () => {
    expect(cheapestModel(['claude-opus-5-5', 'claude-haiku-5-5', 'claude-unknown'])).toBe('claude-haiku-5-5');
    expect(cheapestModel(['gpt-6-sol', 'gpt-6-luna-20260101'])).toBe('gpt-6-luna-20260101');
    expect(cheapestModel(['made-up'])).toBeNull();
  });
});

const t = (inputTokens: number, outputTokens: number, cachedTokens = 0, cacheWriteTokens = 0) => ({ inputTokens, outputTokens, cachedTokens, cacheWriteTokens });

describe('tokenCost', () => {
  it('bills Claude cache reads and writes apart from input', () => {
    // Opus 5.5: $4 in, $20 out, $0.20 read, $5 write per MTok.
    const cost = tokenCost('claude', 'claude-opus-5-5', t(1_000_000, 1_000_000, 1_000_000, 1_000_000))!;
    expect(cost.usd).toBeCloseTo(4 + 20 + 0.2 + 5);
    expect(cost.uncachedUsd).toBeCloseTo(3 * 4 + 20);
  });
  it('treats OpenAI cached tokens as part of input', () => {
    // gpt-6.1-sol: $2 in, $0.10 cached, $10 out.
    const cost = tokenCost('codex', 'gpt-6.1-sol', t(100_000, 0, 40_000))!;
    expect(cost.usd).toBeCloseTo(0.06 * 2 + 0.04 * 0.1);
    expect(promptTokens('codex', t(100_000, 0, 40_000))).toBe(100_000);
  });
  it('prices OpenAI prompts over 272K at the long-context rates', () => {
    expect(tokenCost('codex', 'gpt-6.1-sol', t(1_000_000, 0))!.usd).toBeCloseTo(4);
  });
  it('prices a long Haiku 5.5 prompt at the higher rates, cache reads included', () => {
    const short = tokenCost('claude', 'claude-haiku-5-5', t(1_000, 1_000_000, 99_000))!;
    const long = tokenCost('claude', 'claude-haiku-5-5', t(1_000, 1_000_000, 100_000))!;
    expect(short.usd).toBeCloseTo(0.001 * 0.1 + 0.5 + 0.099 * 0.01);
    expect(long.usd).toBeCloseTo(0.001 * 0.5 + 2.5 + 0.1 * 0.05);
  });
  it('skips the long step for summed totals', () => {
    expect(tokenCost('claude', 'claude-haiku-5-5', t(1_000_000, 0), false)!.usd).toBeCloseTo(0.1);
  });
  it('matches dated snapshots and returns null for unknown models', () => {
    expect(tokenCost('claude', 'claude-opus-5-5-20260901', t(1_000_000, 0))!.usd).toBeCloseTo(4);
    expect(tokenCost('codex', 'gpt-image-2', t(10, 10))).toBeNull();
  });
});
