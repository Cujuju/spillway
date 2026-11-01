import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { connect, createServer } from 'node:net';
import { appPaths, USER_CONFIG_NAME } from './paths';
import { buildProxyConfig } from './proxyConfig';
import { proxyIdentity } from './proxyIdentity';
import { getSettings, writeFileAtomic } from './settingsStore';

/** Environment variable the proxy reads its supervisor password from (cleared by the proxy after reading). */
export const SUPERVISOR_PASSWORD_ENV = 'MANAGEMENT_SUPERVISOR_PASSWORD';
/** 32 random bytes as hex: 64 characters, above the proxy's 32-character minimum. */
const SUPERVISOR_PASSWORD_BYTES = 32;
/** A local listener answers well inside this. */
const PORT_PROBE_TIMEOUT_MS = 1_000;
/** Editors save in several writes; apply once they settle. */
const USER_CONFIG_SETTLE_MS = 300;
const LOOPBACK = '127.0.0.1';
const ALL_IPV4 = '0.0.0.0';

/** Per-launch management password: never written to disk, so nothing can read or rewrite it. */
export const newSupervisorPassword = () => randomBytes(SUPERVISOR_PASSWORD_BYTES).toString('hex');

const USER_CONFIG_TEMPLATE = `# Custom proxy settings, merged into config.yaml (v8 layout; see config.example.yaml upstream).
# The app owns server.host/port, management, routing strategy/affinity, oauth.auth-dir and the
# first-byte timeout; values you set for those are replaced. Saving this file applies it live.
`;

export function readUserConfig(): string {
  const file = appPaths.proxyUserConfigFile;
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

/** Saves config.user.yaml. The caller applies it to a running proxy. */
export function writeUserConfig(text: string): void {
  writeFileAtomic(appPaths.proxyUserConfigFile, text);
}

/** Regenerates config.yaml from settings and config.user.yaml; returns the user file's error, if any. */
export function writeProxyConfig(): string | null {
  const identity = proxyIdentity();
  mkdirSync(identity.authDir, { recursive: true });
  const { yaml, userConfigError } = buildProxyConfig({
    settings: getSettings().proxy,
    clientApiKeys: identity.clientApiKeys,
    managementKey: identity.managementSecret,
    authDir: identity.authDir,
    userConfig: readUserConfig(),
  });
  writeFileAtomic(appPaths.proxyConfigFile, yaml);
  return userConfigError;
}

/** Creates config.user.yaml with a header when missing; returns its path. */
export function ensureUserConfigFile(): string {
  const file = appPaths.proxyUserConfigFile;
  if (!existsSync(file)) writeFileAtomic(file, USER_CONFIG_TEMPLATE);
  return file;
}

/** Calls onChange after config.user.yaml is saved. The directory is watched so the file may be created later. */
export function watchUserConfig(onChange: () => void): FSWatcher {
  mkdirSync(appPaths.proxyDir, { recursive: true });
  let timer: NodeJS.Timeout | null = null;
  return watch(appPaths.proxyDir, (_event, name) => {
    if (name !== USER_CONFIG_NAME) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, USER_CONFIG_SETTLE_MS);
  });
}

function acceptsConnection(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: LOOPBACK });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/**
 * True when another program holds the port. A bind test alone misses it: Windows lets a socket bind
 * a specific address under another program's wildcard listener.
 */
export async function portInUse(port: number, allowLan: boolean): Promise<boolean> {
  if (await acceptsConnection(port)) return true;
  return !(await canBind(port, allowLan ? ALL_IPV4 : LOOPBACK));
}
