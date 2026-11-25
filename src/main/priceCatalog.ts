/** Daily LiteLLM catalog for models the bundled table lacks. The cache file is their dated price history. */

// Residual: a change starts on the UTC day it is first downloaded. Deleting the cache resets history to current rates.
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { installCatalogPrices, samePrice, type CatalogPrices, type ModelPrice, type PriceCatalogInfo } from '@shared/modelPrices';
import { catalogFromLiteLLM } from './litellmPrices';

export const LITELLM_PRICES_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
/** Chosen cadence: list prices change rarely; new models appear within a day. */
export const CATALOG_REFRESH_MS = 24 * 60 * 60 * 1000;
/** A failed download retries hourly, so an outage costs one small request an hour. */
export const CATALOG_RETRY_MS = 60 * 60 * 1000;
/** "YYYY-MM-DD" of an ISO timestamp: price entries start on UTC dates (modelPrices.priceAt). */
const UTC_DATE_LENGTH = 10;
/** The file is ~1.5 MB; a healthy download takes a few seconds. */
const REQUEST_TIMEOUT_MS = 60_000;
/** Bump when the cache's shape changes, so an older cache downloads again. 2: dated histories. */
const CACHE_FORMAT = 2;

interface CachedCatalog { format: number; fetchedAt: string; prices: CatalogPrices }

/** Changed rates start on `day` (UTC); earlier requests keep the old price. First rates cover all history; dropped models keep theirs. */
export function mergeCatalog(previous: CatalogPrices, latest: Record<string, ModelPrice>, day: string): CatalogPrices {
  const merged: Record<string, readonly ModelPrice[]> = { ...previous };
  for (const [id, price] of Object.entries(latest)) {
    const history = previous[id] ?? [];
    const last = history.at(-1);
    if (!last) merged[id] = [{ ...price, from: null }];
    else if (samePrice(last, price)) continue;
    // A second change on the same day replaces that day's entry.
    else if (last.from === day) merged[id] = [...history.slice(0, -1), { ...price, from: day }];
    else merged[id] = [...history, { ...price, from: day }];
  }
  return merged;
}

export interface PriceCatalogDeps {
  file: string;
  fetch: (url: string, init: { signal: AbortSignal }) => Promise<Response>;
  write: (file: string, text: string) => void;
  now?: () => number;
}

export class PriceCatalog extends EventEmitter<{ change: [CatalogPrices] }> {
  private cached: CachedCatalog | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  constructor(private deps: PriceCatalogDeps) { super(); }

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  prices(): CatalogPrices { return this.cached?.prices ?? {}; }
  info(): PriceCatalogInfo { return { fetchedAt: this.cached?.fetchedAt ?? null, models: Object.keys(this.prices()).length }; }

  /** Installs the cached catalog in this thread, then schedules the next download. */
  start(): void {
    this.cached = this.readCache();
    installCatalogPrices(this.prices());
    const age = this.cached ? this.now() - Date.parse(this.cached.fetchedAt) : Infinity;
    this.schedule(Number.isFinite(age) ? Math.max(0, CATALOG_REFRESH_MS - age) : 0);
  }

  stop(): void { this.stopped = true; clearTimeout(this.timer); }

  /** Downloads and installs the catalog; a failure keeps the previous one. Resolves true when prices changed. */
  async refresh(): Promise<boolean> {
    const res = await this.deps.fetch(LITELLM_PRICES_URL, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${LITELLM_PRICES_URL}`);
    const latest = catalogFromLiteLLM(await res.json());
    if (!Object.keys(latest).length) throw new Error('LiteLLM price file lists no first-party models');
    const fetchedAt = new Date(this.now()).toISOString();
    const prices = mergeCatalog(this.prices(), latest, fetchedAt.slice(0, UTC_DATE_LENGTH));
    const changed = JSON.stringify(prices) !== JSON.stringify(this.prices());
    this.cached = { format: CACHE_FORMAT, fetchedAt, prices };
    this.deps.write(this.deps.file, JSON.stringify(this.cached));
    if (changed) {
      installCatalogPrices(prices);
      this.emit('change', prices);
    }
    return changed;
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.refresh().then(() => this.schedule(CATALOG_REFRESH_MS), (error) => {
        console.error('[prices] catalog download failed; retrying in an hour:', error instanceof Error ? error.message : error);
        this.schedule(CATALOG_RETRY_MS);
      });
    }, delay);
    this.timer.unref?.();
  }

  private readCache(): CachedCatalog | null {
    try {
      const parsed = JSON.parse(readFileSync(this.deps.file, 'utf8')) as Partial<CachedCatalog>;
      const valid = parsed.format === CACHE_FORMAT && typeof parsed.fetchedAt === 'string' && !Number.isNaN(Date.parse(parsed.fetchedAt))
        && !!parsed.prices && typeof parsed.prices === 'object' && Object.values(parsed.prices).every(Array.isArray);
      return valid ? parsed as CachedCatalog : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[prices] cached catalog unreadable; downloading again:', error);
      return null;
    }
  }
}
