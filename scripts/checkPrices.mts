/**
 * Compares src/shared/modelPrices.ts with Anthropic's and OpenAI's pricing pages and keeps one GitHub issue
 * listing the differences. Run daily by .github/workflows/prices.yml; `--dry-run` prints the report only.
 */
import { execFileSync } from 'node:child_process';
import { latestPrices, reportsCacheWrites, type TierPrice, type Rates } from '../src/shared/modelPrices.ts';

const ANTHROPIC_URL = 'https://platform.claude.com/docs/en/about-claude/pricing.md';
const OPENAI_URL = 'https://developers.openai.com/api/docs/pricing.md';
export const ISSUE_TITLE = 'Model prices differ from the pricing pages';
const ISSUE_LABEL = 'bug';
/** Prices are cents or fractions of a cent per MTok; anything smaller is float noise. */
const SAME_PRICE_EPSILON = 1e-9;
/** A healthy fetch of these ~60 KB pages takes under a second. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Waits between attempts: rides out a brief CDN blip; longer outages wait for the next scheduled run. */
const RETRY_DELAYS_MS = [5_000, 30_000];
/** Rate limits, bot challenges (403) and server errors pass; 404/410 mean the page moved, which needs a fix. */
const isTransientStatus = (status: number) => status === 403 || status === 408 || status === 429 || status >= 500;

/** Page rates; null where the page lists none ("-"). */
export interface PageRates { input: number; output: number; cacheRead: number | null; cacheWrite: number | null; cacheWriteLong: number | null }
export interface PagePrice { rates: PageRates; long?: PageRates; tiers?: { fast?: PagePrice; flex?: PagePrice } }
type Page = Map<string, PagePrice>;

interface Source { name: string; url: string; provider: string; owns: (id: string) => boolean; parse: (md: string) => Page }

/** Text between a heading line and the next heading of the same or higher level. */
function section(md: string, heading: string): string {
  const start = md.indexOf(`\n${heading}\n`);
  if (start < 0) throw new Error(`heading not found: ${heading}`);
  const level = heading.match(/^#+/)![0];
  const rest = md.slice(start + heading.length + 2);
  const end = rest.search(new RegExp(`\\n#{1,${level.length}} `));
  return end < 0 ? rest : rest.slice(0, end);
}

/** Each markdown table as rows of header-keyed cells. */
function tables(md: string): Record<string, string>[][] {
  const out: Record<string, string>[][] = [];
  let lines: string[] = [];
  const flush = () => {
    if (lines.length > 2) {
      const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const header = cells(lines[0]!);
      out.push(lines.slice(2).map((line) => Object.fromEntries(cells(line).map((c, i) => [header[i]!, c]))));
    }
    lines = [];
  };
  for (const line of md.split('\n')) line.trim().startsWith('|') ? lines.push(line) : flush();
  flush();
  return out;
}

/** "$0.20 / MTok<sup>1</sup>" → 0.2; "-" → null; anything else fails the run. */
export function money(cell: string | undefined): number | null {
  const text = (cell ?? '').replace(/<sup>.*?<\/sup>/g, '').trim();
  if (text === '-') return null;
  const m = text.match(/^\$([\d,]*\.?\d+)/);
  if (!m) throw new Error(`unreadable price: "${cell}"`);
  return Number(m[1]!.replace(/,/g, ''));
}

const required = (cell: string | undefined) => {
  const value = money(cell);
  if (value === null) throw new Error(`missing required price: "${cell}"`);
  return value;
};

export function parseAnthropic(md: string): Page {
  const table = tables(section(md, '## Model pricing'))[0];
  if (!table?.length) throw new Error('Anthropic model table not found');
  const page: Page = new Map();
  for (const row of table) {
    const name = row['Model'] ?? '';
    const rates = { input: required(row['Base input tokens']), output: required(row['Output tokens']),
      cacheRead: money(row['Cache hits and refreshes']), cacheWrite: money(row['5m cache writes']), cacheWriteLong: money(row['1h cache writes']) };
    // "Claude Sonnet 5.5 ([retired…](…))" → "claude-sonnet-5-5"
    const id = name.replace(/\s*\(.*$/, '').trim().toLowerCase().replace(/[\s.]+/g, '-');
    const entry = page.get(id);
    if (/\(for prompts over [\d,]+ tokens\)/.test(name)) page.set(id, { rates: entry?.rates ?? rates, long: rates });
    else page.set(id, { ...entry, rates });
  }
  const fast = tables(section(md, '### Fast mode pricing'))[0];
  if (!fast?.length) throw new Error('Anthropic fast-mode table not found');
  for (const row of fast) {
    for (const name of (row['Model'] ?? '').split(' / ')) {
      const id = name.trim().toLowerCase().replace(/[\s.]+/g, '-');
      const entry = page.get(id);
      if (!entry) throw new Error(`Anthropic fast model absent from standard table: ${id}`);
      const input = required(row['Input']);
      const scale = input / entry.rates.input;
      entry.tiers = { fast: { rates: { input, output: required(row['Output']),
        cacheRead: entry.rates.cacheRead === null ? null : entry.rates.cacheRead * scale,
        cacheWrite: entry.rates.cacheWrite === null ? null : entry.rates.cacheWrite * scale,
        cacheWriteLong: entry.rates.cacheWriteLong === null ? null : entry.rates.cacheWriteLong * scale } } };
    }
  }
  return page;
}

export function parseOpenAI(md: string): Page {
  const page = parseOpenAITables(section(md, '### Standard pricing data'));
  for (const [tier, heading] of [['flex', '#### Flex'], ['fast', '### Fast pricing data']] as const) {
    for (const [id, price] of parseOpenAITables(section(md, heading))) {
      const entry = page.get(id);
      if (!entry) throw new Error(`OpenAI ${tier} model absent from standard table: ${id}`);
      entry.tiers = { ...entry.tiers, [tier]: price };
    }
  }
  return page;
}

function parseOpenAITables(md: string): Page {
  const found = tables(md);
  if (!found.length) throw new Error('OpenAI standard pricing tables not found');
  const page: Page = new Map();
  for (const row of found.flat()) {
    const id = (row['Model'] ?? '').replace(/\s*\(.*$/, '').trim().toLowerCase();
    if ('Short context input' in row) {
      const at = (prefix: string): PageRates => ({ input: required(row[`${prefix} input`]), output: required(row[`${prefix} output`]),
        cacheRead: money(row[`${prefix} cached input`]), cacheWrite: money(row[`${prefix} 30m write`]), cacheWriteLong: money(row[`${prefix} 12h write`]) });
      page.set(id, { rates: at('Short context'), long: money(row['Long context input']) === null ? undefined : at('Long context') });
    } else {
      page.set(id, { rates: { input: required(row['Input']), output: required(row['Output']), cacheRead: money(row['Cached input']), cacheWrite: null, cacheWriteLong: null } });
    }
  }
  return page;
}

const SOURCES: Source[] = [
  { name: 'Anthropic', url: ANTHROPIC_URL, provider: 'claude', owns: (id) => id.startsWith('claude-'), parse: parseAnthropic },
  { name: 'OpenAI', url: OPENAI_URL, provider: 'codex', owns: (id) => !id.startsWith('claude-'), parse: parseOpenAI },
];

const fmt = (n: number | null | undefined) => n == null ? '—' : `$${n}`;

/** Differences in the fields Spillway bills. */
function rateDiffs(provider: string, ours: Rates, page: PageRates, label: string): string[] {
  const fields: (keyof PageRates)[] = ['input', 'output', 'cacheRead', ...(reportsCacheWrites(provider) ? ['cacheWrite' as const, 'cacheWriteLong' as const] : [])];
  return fields.filter((f) => page[f] !== null && Math.abs(ours[f] - page[f]!) > SAME_PRICE_EPSILON)
    .map((f) => `${label}${f}: ${fmt(ours[f])} → ${fmt(page[f])}`);
}

/** Markdown lines describing how one source's page differs from the table; empty when it matches. */
export function compare(source: Pick<Source, 'name' | 'url' | 'provider' | 'owns'>, page: Page, ours: Map<string, { rates: Rates; long?: Rates; tiers?: { fast?: TierPrice; flex?: TierPrice } }>): string[] {
  const tracked = [...ours.keys()].filter(source.owns);
  if (!tracked.some((id) => page.has(id))) throw new Error(`${source.name}: no tracked model found on the page; its layout may have changed`);
  const lines: string[] = [];
  for (const [id, p] of page) {
    const mine = ours.get(id);
    if (!mine) { lines.push(`- **New:** \`${id}\` input ${fmt(p.rates.input)}, output ${fmt(p.rates.output)}, cache read ${fmt(p.rates.cacheRead)}`); continue; }
    const diffs = [...rateDiffs(source.provider, mine.rates, p.rates, ''),
      ...(p.long && mine.long ? rateDiffs(source.provider, mine.long, p.long, 'long-context ') : []),
      ...(p.long && !mine.long ? ['long-context rates listed but not tracked'] : [])];
    for (const tier of ['fast', 'flex'] as const) {
      const listed = p.tiers?.[tier];
      const tracked = mine.tiers?.[tier];
      if (listed && !tracked) diffs.push(`${tier} rates listed but not tracked`);
      if (tracked && !listed) diffs.push(`${tier} rates tracked but not listed`);
      if (listed && tracked) {
        diffs.push(...rateDiffs(source.provider, tracked.rates, listed.rates, `${tier} `));
        if (listed.long && tracked.long) diffs.push(...rateDiffs(source.provider, tracked.long, listed.long, `${tier} long-context `));
        if (listed.long && !tracked.long) diffs.push(`${tier} long-context rates listed but not tracked`);
        if (tracked.long && !listed.long) diffs.push(`${tier} long-context rates tracked but not listed`);
      }
    }
    if (diffs.length) lines.push(`- **Changed:** \`${id}\` ${diffs.join('; ')}`);
  }
  // Models dropped from the page stay priced for past requests, so they need no action.
  return lines.length ? [`### ${source.name} ([page](${source.url.replace(/\.md$/, '')}))`, ...lines] : [];
}

const gh = (...args: string[]) => execFileSync('gh', args, { encoding: 'utf8' }).trim();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
class PageGone extends Error {}

/**
 * The page's markdown, or null when it stays unreachable after retries (network error, timeout, transient
 * status, HTML instead of markdown). Throws when the page is gone (404/410).
 */
export async function fetchPage(url: string, get: typeof fetch = fetch, delays = RETRY_DELAYS_MS): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    let why: string;
    try {
      const res = await get(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok && res.headers.get('content-type')?.includes('markdown')) return await res.text();
      if (!res.ok && !isTransientStatus(res.status)) throw new PageGone(`HTTP ${res.status} from ${url}`);
      why = res.ok ? `served ${res.headers.get('content-type')}, not markdown` : `HTTP ${res.status}`;
    } catch (err) {
      if (err instanceof PageGone) throw err;
      why = err instanceof Error ? err.message : String(err);
    }
    if (attempt >= delays.length) { console.log(`::warning::${url} unreachable (${why}); the next scheduled run will retry.`); return null; }
    await sleep(delays[attempt]!);
  }
}

async function main(): Promise<void> {
  const ours = latestPrices();
  const report: string[] = [];
  let complete = true;
  for (const source of SOURCES) {
    const md = await fetchPage(source.url);
    if (md === null) { complete = false; continue; }
    report.push(...compare(source, source.parse(md), ours));
  }
  const today = new Date().toISOString().slice(0, 10);
  const body = [...report, '', `Update \`src/shared/modelPrices.ts\` with a dated entry per change. "Detected" is when this check first saw it; use the announced date when known.`].join('\n');
  console.log(report.length ? body : 'Prices match the pages that were read.');
  // A partial report would drop the skipped page's differences from the issue, so leave it as is.
  if (process.argv.includes('--dry-run') || !complete) return;
  try {
    syncIssue(report, body, today);
  } catch (err) {
    // Each run rebuilds the issue from scratch, so the next one repairs a failed GitHub call.
    console.log(`::warning::GitHub issue not updated (${err instanceof Error ? err.message : err}); the next scheduled run will retry.`);
  }
}

/** Keeps one open issue matching the report: opens, updates, or closes it when prices match. */
function syncIssue(report: string[], body: string, today: string): void {
  const open = JSON.parse(gh('issue', 'list', '--state', 'open', '--search', `"${ISSUE_TITLE}" in:title`, '--json', 'number,title,body')) as { number: number; title: string; body: string }[];
  const issue = open.find((i) => i.title === ISSUE_TITLE);
  const stamped = `${body}\n\nDetected: ${today}`;
  if (!report.length) {
    if (issue) console.log(gh('issue', 'close', String(issue.number), '--comment', `Prices match both pages (checked ${today}).`));
  } else if (!issue) console.log(gh('issue', 'create', '--title', ISSUE_TITLE, '--label', ISSUE_LABEL, '--body', stamped));
  else if (issue.body.replace(/\r\n/g, '\n').replace(/\n\nDetected: .*$/s, '') !== body) {
    gh('issue', 'edit', String(issue.number), '--body', stamped);
    gh('issue', 'comment', String(issue.number), '--body', `The differences changed (detected ${today}).`);
    console.log(`updated #${issue.number}`);
  }
}

if (import.meta.main) await main();
