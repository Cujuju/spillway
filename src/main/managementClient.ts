import type { OAuthStart, OAuthStatus, UsageSnapshot } from '@shared/types';
import { parseUsageSnapshot } from './usageParse';

/** Management calls are loopback; anything slower means the proxy is wedged. */
const REQUEST_TIMEOUT_MS = 10_000;
/** Usage refresh calls Anthropic once per account, so it gets more room. */
const REFRESH_TIMEOUT_MS = 60_000;
const PING_TIMEOUT_MS = 1_500;

export class ManagementError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

class ManagementClient {
  private base = '';
  private key = '';

  configure(endpoint: string, key: string): void {
    this.base = `${endpoint}/v8/management`;
    this.key = key;
  }

  private async request(method: string, path: string, body?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (!this.base) throw new ManagementError('Proxy not configured', 0);
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.key}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data: unknown = undefined;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const message = typeof data === 'object' && data && 'error' in data ? String((data as { error: unknown }).error) : `HTTP ${res.status}`;
      throw new ManagementError(message, res.status);
    }
    return data;
  }

  async ping(): Promise<boolean> {
    try {
      await this.request('GET', '/config/routing/strategy', undefined, PING_TIMEOUT_MS);
      return true;
    } catch {
      return false;
    }
  }

  async usage(): Promise<UsageSnapshot> {
    return parseUsageSnapshot(await this.request('GET', '/usage/windows'));
  }

  async refreshUsage(authIndex?: string): Promise<UsageSnapshot> {
    return parseUsageSnapshot(await this.request('POST', '/usage/refresh', authIndex ? { auth_index: authIndex } : {}, REFRESH_TIMEOUT_MS));
  }

  async shutdown(): Promise<boolean> {
    try {
      await this.request('POST', '/server/shutdown', {});
      return true;
    } catch {
      return false;
    }
  }

  async startOAuth(provider: string): Promise<OAuthStart> {
    const q = new URLSearchParams({ provider, is_webui: 'true' });
    const data = (await this.request('GET', `/oauth/auth-url?${q}`)) as { url?: unknown; state?: unknown };
    if (typeof data?.url !== 'string' || typeof data.state !== 'string') throw new ManagementError('Proxy returned no sign-in URL', 0);
    return { url: data.url, state: data.state };
  }

  async oauthStatus(state: string): Promise<OAuthStatus> {
    const data = (await this.request('GET', `/oauth/status?${new URLSearchParams({ state })}`)) as { status?: unknown; error?: unknown };
    if (data?.status === 'ok') return { status: 'ok' };
    if (data?.status === 'wait') return { status: 'wait' };
    return { status: 'error', error: typeof data?.error === 'string' ? data.error : 'Sign-in failed' };
  }

  async cancelOAuth(state: string): Promise<void> {
    await this.request('DELETE', `/oauth/session?${new URLSearchParams({ state })}`);
  }

  async setDisabled(name: string, disabled: boolean): Promise<void> {
    await this.request('PATCH', '/credentials/status', { name, disabled });
  }

  async setFields(name: string, fields: { note?: string; priority?: number }): Promise<void> {
    await this.request('PATCH', '/credentials/fields', { name, ...fields });
  }

  async deleteCredential(name: string): Promise<void> {
    await this.request('DELETE', `/credentials?${new URLSearchParams({ name })}`);
  }

  /** v8 PUT /config/<path> replaces that YAML node with the raw JSON body, so values go unwrapped. */
  async setRouting(strategy: string, sessionAffinity: boolean, affinityTtl: string): Promise<void> {
    await this.request('PUT', '/config/routing/strategy', strategy);
    await this.request('PUT', '/config/routing/session-affinity', sessionAffinity);
    await this.request('PUT', '/config/routing/session-affinity-ttl', affinityTtl);
  }
}

export const management = new ManagementClient();
