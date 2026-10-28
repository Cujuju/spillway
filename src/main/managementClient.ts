import { parseBuildInfo, type BuildInfo } from '@shared/buildInfo';
import { RESET_CREDIT_OUTCOMES, type CredentialModel, type CredentialRenewResult, type ManagementLockout,type OAuthStart, type OAuthStatus, type ResetCreditOutcome, type UsageSnapshot } from '@shared/types';
import { parseUsageSnapshot } from './usageParse';

/** Management calls are loopback; anything slower means the proxy is wedged. */
const REQUEST_TIMEOUT_MS = 10_000;
/** Usage refresh calls Anthropic once per account, so it gets more room. */
const REFRESH_TIMEOUT_MS = 60_000;
const PING_TIMEOUT_MS = 1_500;
/** The proxy bounds a window start at one minute (docs/desktop-api.md); this leaves room for its reply. */
const WINDOW_START_TIMEOUT_MS = 70_000;

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
    return (await this.send(method, path, body === undefined ? undefined : JSON.stringify(body), timeoutMs)).data;
  }

  /** `bodyText` is sent verbatim as JSON; `text` is the response before parsing. */
  private async send(method: string, path: string, bodyText: string | undefined, timeoutMs: number): Promise<{ data: unknown; text: string; headers: Headers }> {
    if (!this.base) throw new ManagementError('Proxy not configured', 0);
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.key}`,
        ...(bodyText === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: bodyText,
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
    return { data, text, headers: res.headers };
  }

  /** The proxy's version and build from its management headers; null while it does not answer. */
  async ping(): Promise<BuildInfo | null> {
    try {
      const { headers } = await this.send('GET', '/config/routing/strategy', undefined, PING_TIMEOUT_MS);
      return parseBuildInfo(headers.get('X-CPA-VERSION'), headers.get('X-CPA-COMMIT'), headers.get('X-CPA-BUILD-DATE'));
    } catch {
      return null;
    }
  }

  async usage(): Promise<UsageSnapshot> {
    return parseUsageSnapshot(await this.request('GET', '/usage/windows'));
  }

  async refreshUsage(authIndex?: string): Promise<UsageSnapshot> {
    return parseUsageSnapshot(await this.request('POST', '/usage/refresh', authIndex ? { auth_index: authIndex } : {}, REFRESH_TIMEOUT_MS));
  }

  /** Spends one reset credit; the proxy answers with ChatGPT's outcome and fresh usage. */
  async useResetCredit(authIndex: string): Promise<{ outcome: ResetCreditOutcome; snapshot: UsageSnapshot }> {
    const res = (await this.request('POST', '/usage/reset-credit', { auth_index: authIndex }, REFRESH_TIMEOUT_MS)) as { code?: unknown; usage?: unknown };
    const outcome = RESET_CREDIT_OUTCOMES.find((o) => o === res.code);
    if (!outcome) throw new Error(`Unexpected reset outcome: ${String(res.code)}`);
    return { outcome, snapshot: parseUsageSnapshot(res.usage) };
  }

  /** Sends one minimal request through the account so its 5-hour window starts now; answers with fresh usage. */
  async startWindow(authIndex: string, model: string): Promise<UsageSnapshot> {
    const res = (await this.request('POST', '/usage/start-window', { auth_index: authIndex, model }, WINDOW_START_TIMEOUT_MS)) as { usage?: unknown };
    return parseUsageSnapshot(res.usage);
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

  /** Saves a login file under `name`, replacing one with the same name. The proxy validates the JSON. */
  async uploadCredential(name: string, json: string): Promise<void> {
    await this.send('POST', `/credentials?${new URLSearchParams({ name })}`, json, REQUEST_TIMEOUT_MS);
  }

  /** The login file's exact bytes as the proxy stores them. */
  async downloadCredential(name: string): Promise<string> {
    return (await this.send('GET', `/credentials/download?${new URLSearchParams({ name })}`, undefined, REQUEST_TIMEOUT_MS)).text;
  }

  async credentialModels(name: string): Promise<CredentialModel[]> {
    return parseCredentialModels(await this.request('GET', `/credentials/models?${new URLSearchParams({ name })}`));
  }

  /** Forces a token refresh for one account, or every account when `name` is omitted. */
  async renewCredentials(name?: string): Promise<CredentialRenewResult> {
    if (name) {
      try {
        await this.request('POST', '/credentials/refresh', { name }, REFRESH_TIMEOUT_MS);
        return { renewed: 1, failed: [] };
      } catch (err) {
        return { renewed: 0, failed: [{ name, error: err instanceof Error ? err.message : String(err) }] };
      }
    }
    return parseRenewAll(await this.request('POST', '/credentials/refresh', { all: true }, REFRESH_TIMEOUT_MS));
  }

  /** Opens the live request stream (server-sent events); the caller reads and closes the body. */
  async events(signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    if (!this.base) throw new ManagementError('Proxy not configured', 0);
    const res = await fetch(`${this.base}/usage/events`, { headers: { Authorization: `Bearer ${this.key}`, Accept: 'text/event-stream' }, signal });
    if (!res.ok || !res.body) throw new ManagementError(`HTTP ${res.status}`, res.status);
    return res.body;
  }

  async lockouts(): Promise<ManagementLockout[]> {
    return parseLockouts(await this.request('GET', '/server/lockouts'));
  }

  async resetLockouts(): Promise<void> {
    await this.request('DELETE', '/server/lockouts');
  }

  /** Tray "Use account" override; an empty authIndex restores automatic routing. */
  async setPreferredAccount(provider: string, authIndex: string): Promise<void> {
    await this.request('PUT', '/routing/preferred-auth', { provider, auth_index: authIndex });
  }
}

export const management = new ManagementClient();

const optStr = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Reads `{ models: [{ id, display_name?, owned_by? }] }`; rows without an id are dropped. */
export function parseCredentialModels(data: unknown): CredentialModel[] {
  const rows = (data as { models?: unknown } | null)?.models;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r: Record<string, unknown>) =>
    typeof r?.id === 'string' && r.id ? [{ id: r.id, displayName: optStr(r.display_name), ownedBy: optStr(r.owned_by) }] : [],
  );
}

/** Reads `{ results: [{ id, success, error? }] }` from a refresh of every account. */
export function parseRenewAll(data: unknown): CredentialRenewResult {
  const rows = (data as { results?: unknown } | null)?.results;
  const list = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  const failed = list.filter((r) => r?.success !== true).map((r) => ({ name: String(r?.id ?? '?'), error: optStr(r?.error) ?? 'Refresh failed' }));
  return { renewed: list.length - failed.length, failed };
}

/** Reads `{ lockouts: [{ ip, failures, failures_allowed, locked_until }] }`; malformed rows are dropped. */
export function parseLockouts(data: unknown): ManagementLockout[] {
  const rows = (data as { lockouts?: unknown } | null)?.lockouts;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r: Record<string, unknown>) =>
    typeof r?.ip === 'string' && typeof r.failures === 'number' && typeof r.failures_allowed === 'number'
      ? [{ ip: r.ip, failures: r.failures, failuresAllowed: r.failures_allowed, lockedUntil: typeof r.locked_until === 'string' ? r.locked_until : null }]
      : [],
  );
}
