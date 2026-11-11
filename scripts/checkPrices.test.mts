import { afterEach, describe, expect, it, vi } from 'vitest';
import { compare, fetchPage, money, parseAnthropic, parseOpenAI } from './checkPrices.mts';

const ANTHROPIC = `
## Model pricing

| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| :-- | :-- | :-- | :-- | :-- | :-- |
| Claude Sonnet 5.5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.10 / MTok<sup>2</sup> | $10 / MTok |
| Claude Opus 4 ([retired, except on X](https://example.com)) | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |
| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |
| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |

## Cloud platform pricing

| Model | Base input tokens | Output tokens |
| :-- | :-- | :-- |
| Claude Elsewhere 1 | $99 / MTok | $99 / MTok |
`;

const OPENAI = `
### Standard pricing data

| Model | Short context input | Short context output | Short context cached input | Short context 30m write | Short context 12h write | Long context input | Long context output | Long context cached input | Long context 30m write | Long context 12h write |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-6.1-sol | $2.00 | $10.00 | $0.10 | $2.50 | $5.00 | $4.00 | $15.00 | $0.20 | $5.00 | $10.00 |
| gpt-5.5 (<272K context length) | $5.00 | $30.00 | $0.50 | - | - | $10.00 | $45.00 | $1.00 | - | - |

| Model | Input | Output | Cached input |
| --- | --- | --- | --- |
| gpt-5.2-pro | $21.00 | $168.00 | - |

### Batch pricing data

| Model | Input | Output | Cached input |
| --- | --- | --- | --- |
| gpt-6.1-sol | $1.00 | $5.00 | $0.05 |
`;

afterEach(() => { vi.restoreAllMocks(); });

const r = (input: number, cacheWrite: number, cacheRead: number, output: number) => ({ input, cacheWrite, cacheRead, output });
const claude = { name: 'Anthropic', url: 'https://a/pricing.md', provider: 'claude', owns: (id: string) => id.startsWith('claude-') };
const openai = { name: 'OpenAI', url: 'https://o/pricing.md', provider: 'codex', owns: (id: string) => !id.startsWith('claude-') };

describe('money', () => {
  it('reads dollars, footnotes and dashes, and rejects anything else', () => {
    expect(money('$0.20 / MTok<sup>1</sup>')).toBe(0.2);
    expect(money('$1,000.50')).toBe(1000.5);
    expect(money('-')).toBeNull();
    expect(() => money('Contact sales')).toThrow('unreadable price');
  });
});

describe('parsers', () => {
  it('reads the Anthropic model table only, with Haiku long-context rows', () => {
    const page = parseAnthropic(ANTHROPIC);
    expect([...page.keys()]).toEqual(['claude-sonnet-5-5', 'claude-opus-4', 'claude-haiku-5-5']);
    expect(page.get('claude-sonnet-5-5')!.rates).toEqual({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
    expect(page.get('claude-haiku-5-5')).toEqual({ rates: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }, long: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 } });
  });
  it('reads OpenAI standard tables only, in both layouts', () => {
    const page = parseOpenAI(OPENAI);
    expect(page.get('gpt-6.1-sol')!.rates).toEqual({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
    expect(page.get('gpt-6.1-sol')!.long!.input).toBe(4);
    expect(page.get('gpt-5.5')!.rates.cacheWrite).toBeNull();
    expect(page.get('gpt-5.2-pro')!.rates).toEqual({ input: 21, output: 168, cacheRead: null, cacheWrite: null });
  });
  it('fails loudly when a section is missing', () => {
    expect(() => parseAnthropic('# nothing')).toThrow('heading not found');
    expect(() => parseOpenAI('# nothing')).toThrow('heading not found');
  });
});

describe('fetchPage', () => {
  const md = (body: string, status = 200, type = 'text/markdown; charset=utf-8') => new Response(body, { status, headers: { 'content-type': type } });
  const replies = (...rs: (Response | Error)[]) => {
    const get = vi.fn<typeof fetch>();
    for (const r of rs) r instanceof Error ? get.mockRejectedValueOnce(r) : get.mockResolvedValueOnce(r);
    return get;
  };
  const NO_WAIT = [0, 0];
  it('retries network errors and transient statuses, then returns the markdown', async () => {
    const get = replies(new Error('ECONNRESET'), md('', 503), md('# ok'));
    expect(await fetchPage('https://x/p.md', get, NO_WAIT)).toBe('# ok');
    expect(get).toHaveBeenCalledTimes(3);
  });
  it('returns null, without throwing, when the page stays unreachable or serves HTML', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await fetchPage('https://x/p.md', replies(md('', 429), md('', 403), md('', 500)), NO_WAIT)).toBeNull();
    expect(await fetchPage('https://x/p.md', replies(...[1, 2, 3].map(() => md('<html>', 200, 'text/html'))), NO_WAIT)).toBeNull();
  });
  it('fails at once when the page is gone', async () => {
    const get = replies(md('', 404));
    await expect(fetchPage('https://x/p.md', get, NO_WAIT)).rejects.toThrow('HTTP 404');
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe('compare', () => {
  it('reports changed and new models, not ones dropped from the page', () => {
    const ours = new Map([
      ['claude-sonnet-5-5', { rates: r(2, 2.5, 0.2, 10) }],
      ['claude-haiku-5-5', { rates: r(0.1, 0.125, 0.01, 0.5), long: r(0.5, 0.625, 0.05, 2.5) }],
      ['claude-gone', { rates: r(1, 1, 1, 1) }],
    ]);
    expect(compare(claude, parseAnthropic(ANTHROPIC), ours)).toEqual([
      '### Anthropic ([page](https://a/pricing))',
      '- **Changed:** `claude-sonnet-5-5` cacheRead: $0.2 → $0.1',
      '- **New:** `claude-opus-4` input $15, output $75, cache read $1.5',
    ]);
  });
  it('is empty when prices match, and ignores OpenAI cache writes', () => {
    const ours = new Map([['gpt-6.1-sol', { rates: r(2, 2, 0.1, 10), long: r(4, 4, 0.2, 15) }]]);
    const page = new Map([...parseOpenAI(OPENAI)].filter(([id]) => id === 'gpt-6.1-sol'));
    expect(compare(openai, page, ours)).toEqual([]);
  });
  it('fails when no tracked model is on the page', () => {
    expect(() => compare(openai, new Map(), new Map([['gpt-6.1-sol', { rates: r(2, 2, 0.1, 10) }]]))).toThrow('no tracked model');
  });
});
