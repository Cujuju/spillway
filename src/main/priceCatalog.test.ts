import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installCatalogPrices, tokenCost } from '@shared/modelPrices';
import { CATALOG_REFRESH_MS, PriceCatalog, type PriceCatalogDeps } from './priceCatalog';

const M = 1e-6;
const NOW = Date.parse('2026-11-24T12:00:00Z');
const FILE = { 'gpt-9-test': { litellm_provider: 'openai', input_cost_per_token: 1 * M, output_cost_per_token: 2 * M } };
const counts = { inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let dir: string;
let file: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'price-catalog-')); file = path.join(dir, 'price-catalog.json'); vi.useFakeTimers({ now: NOW }); });
afterEach(() => { vi.useRealTimers(); installCatalogPrices({}); rmSync(dir, { recursive: true, force: true }); });

const make = (fetch: ReturnType<typeof vi.fn>) =>
  new PriceCatalog({ file, fetch: fetch as unknown as PriceCatalogDeps['fetch'], write: (f, text) => writeFileSync(f, text), now: () => Date.now() });

describe('PriceCatalog', () => {
  it('downloads at once without a cache, then prices the new model and caches it', async () => {
    const fetch = vi.fn().mockResolvedValue(json(FILE));
    const catalog = make(fetch);
    const change = vi.fn();
    catalog.on('change', change);
    catalog.start();
    expect(tokenCost('codex', 'gpt-9-test', NOW, counts)).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(change).toHaveBeenCalledTimes(1);
    expect(tokenCost('codex', 'gpt-9-test', NOW, counts)!.usd).toBeCloseTo(1);
    expect(JSON.parse(readFileSync(file, 'utf8')).fetchedAt).toBe(new Date(NOW).toISOString());
    expect(catalog.info()).toEqual({ fetchedAt: new Date(NOW).toISOString(), models: 1 });
    catalog.stop();
  });

  it('installs a fresh cache without downloading until it is a day old', async () => {
    const fetch = vi.fn().mockResolvedValue(json(FILE));
    const hourOld = new Date(NOW - 60 * 60 * 1000).toISOString();
    writeFileSync(file, JSON.stringify({ format: 1, fetchedAt: hourOld, prices: { 'gpt-9-test': { from: null, rates: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1, cacheWriteLong: 1 } } } }));
    const catalog = make(fetch);
    catalog.start();
    expect(tokenCost('codex', 'gpt-9-test', NOW, counts)!.usd).toBeCloseTo(1);
    await vi.advanceTimersByTimeAsync(CATALOG_REFRESH_MS - 60 * 60 * 1000 - 1);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    catalog.stop();
  });

  it('keeps the previous catalog when a download fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = vi.fn().mockResolvedValueOnce(json(FILE)).mockResolvedValueOnce(json({}, 503));
    const catalog = make(fetch);
    await catalog.refresh();
    await expect(catalog.refresh()).rejects.toThrow('HTTP 503');
    expect(catalog.prices()).toHaveProperty('gpt-9-test');
    expect(tokenCost('codex', 'gpt-9-test', NOW, counts)).not.toBeNull();
  });

  it('refuses a file with no first-party models', async () => {
    const catalog = make(vi.fn().mockResolvedValue(json({ other: { litellm_provider: 'perplexity', input_cost_per_token: M, output_cost_per_token: M } })));
    await expect(catalog.refresh()).rejects.toThrow('no first-party models');
  });
});
