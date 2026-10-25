import { management, ManagementError } from './managementClient';
import { proxy } from './proxySupervisor';
import { getSettings, setSettings } from './settingsStore';
import { usage } from './usagePoller';

/** The proxy rejects an override for an account it no longer has (deleted) or that moved provider. */
const GONE_STATUSES = new Set([400, 404]);

function savePreferred(preferredAccounts: Record<string, string>): void {
  const s = getSettings();
  setSettings({ ...s, proxy: { ...s.proxy, preferredAccounts } });
}

/** Re-applies stored overrides after the proxy starts; it keeps them in memory only. Gone accounts are dropped. */
export async function syncPreferredAccounts(): Promise<void> {
  const stored = getSettings().proxy.preferredAccounts;
  const kept = { ...stored };
  for (const [provider, authIndex] of Object.entries(stored)) {
    try {
      await management.setPreferredAccount(provider, authIndex);
    } catch (err) {
      if (err instanceof ManagementError && GONE_STATUSES.has(err.status)) delete kept[provider];
      else console.error(`[preferred] ${provider}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (Object.keys(kept).length !== Object.keys(stored).length) savePreferred(kept);
}

/** Tray "Use account": an empty authIndex restores automatic routing for the provider. */
export async function usePreferredAccount(provider: string, authIndex: string): Promise<void> {
  // Apply first so a rejected choice is never stored.
  if (proxy.isRunning()) await management.setPreferredAccount(provider, authIndex);
  const next = { ...getSettings().proxy.preferredAccounts };
  if (authIndex) next[provider] = authIndex;
  else delete next[provider];
  savePreferred(next);
  await usage.poll();
}
