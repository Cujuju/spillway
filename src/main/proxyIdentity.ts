import { app } from 'electron';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isSeq, parseDocument } from 'yaml';
import { appIdentity, IS_DEV_BUILD } from '@shared/app';
import { appPaths } from './paths';
import { getSecrets } from './settingsStore';

/** Keys and accounts the proxy runs with. */
export interface ProxyIdentity {
  /** Every client key the proxy accepts; [0] is the one Apply writes. */
  clientApiKeys: string[];
  /** Written to management.secret-key: plaintext, or the bcrypt hash production's proxy stored. */
  managementSecret: string;
  /** Plaintext management key for outside tools; null when shared (only the hash is known). */
  managementKey: string | null;
  authDir: string;
  /** Production's app name when the dev build uses its keys and accounts; null otherwise. */
  sharedFrom: string | null;
}

/** Reads production's client keys, management secret and accounts directory; invalid or incomplete config returns null. */
export function parseProductionProxy(text: string): Pick<ProxyIdentity, 'clientApiKeys' | 'managementSecret' | 'authDir'> | null {
  try {
    const doc = parseDocument(text);
    if (doc.errors.length) return null;
    const keys = doc.getIn(['access', 'api-keys']);
    const managementSecret = doc.getIn(['management', 'secret-key']);
    const authDir = doc.getIn(['oauth', 'auth-dir']);
    if (!isSeq(keys)) return null;
    const clientApiKeys = keys.toJSON() as unknown[];
    if (!clientApiKeys.length || !clientApiKeys.every((key): key is string => typeof key === 'string' && !!key.trim())) return null;
    if (typeof managementSecret !== 'string' || !managementSecret.trim() || typeof authDir !== 'string' || !authDir.trim()) return null;
    return { clientApiKeys, managementSecret, authDir };
  } catch {
    return null;
  }
}

/** Dev builds share production's identity when its config is readable and complete. */
export function proxyIdentity(): ProxyIdentity {
  if (IS_DEV_BUILD) {
    const sharedFrom = appIdentity(false).name;
    try {
      const file = path.join(app.getPath('appData'), sharedFrom, 'proxy', 'config.yaml');
      const identity = parseProductionProxy(readFileSync(file, 'utf8'));
      if (identity) return { ...identity, managementKey: null, sharedFrom };
    } catch { /* Missing or unreadable production config uses this build's identity. */ }
  }
  const { clientApiKey, managementKey } = getSecrets();
  return { clientApiKeys: [clientApiKey], managementSecret: managementKey, managementKey, authDir: appPaths.authDir, sharedFrom: null };
}
