import { afterEach, describe, expect, it, vi } from 'vitest';
import { listUpstreamModels } from './upstreamModels';

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

describe('listUpstreamModels', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lists Anthropic models with the typed key and the version header', async () => {
    const fetch = vi.fn(async () => ok([{ id: 'claude-sonnet-5-5' }, { id: 'claude-opus-5-5' }, { id: 'claude-opus-5-5' }]));
    vi.stubGlobal('fetch', fetch);
    const ids = await listUpstreamModels({ family: 'claude', baseUrl: '', key: 'sk-typed', target: null }, () => null);
    expect(ids).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/models?limit=1000');
    expect(init.headers).toMatchObject({ 'x-api-key': 'sk-typed', 'anthropic-version': '2023-06-01' });
  });

  it('falls back to the saved key of the group being edited', async () => {
    const fetch = vi.fn(async () => ok([{ id: 'gpt-x' }]));
    vi.stubGlobal('fetch', fetch);
    const saved = vi.fn(() => 'sk-saved');
    await listUpstreamModels({ family: 'openai-compatibility', baseUrl: 'https://example.test/v1/', key: null, target: { family: 'openai-compatibility', name: 'x' } }, saved);
    expect(saved).toHaveBeenCalledWith({ family: 'openai-compatibility', name: 'x' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://example.test/v1/models');
    expect(init.headers).toEqual({ authorization: 'Bearer sk-saved' });
  });

  it('refuses families without a readable list, and reports upstream refusals without the key', async () => {
    await expect(listUpstreamModels({ family: 'gemini', baseUrl: '', key: 'k', target: null }, () => null)).rejects.toThrow(/Type the model names/);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    await expect(listUpstreamModels({ family: 'claude', baseUrl: '', key: 'sk-secret', target: null }, () => null)).rejects.toThrow(/^(?!.*sk-secret).*HTTP 401/);
  });
});
