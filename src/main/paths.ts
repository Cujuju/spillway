import { app } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const PROXY_EXE_NAME = 'cli-proxy-api.exe';

/** All app-owned state lives under Electron's per-user data folder. */
export const appPaths = {
  get root() {
    return app.getPath('userData');
  },
  get settingsFile() {
    return path.join(this.root, 'settings.json');
  },
  get secretsFile() {
    return path.join(this.root, 'secrets.bin');
  },
  get historyFile() {
    return path.join(this.root, 'usage-history.json');
  },
  get windowStateFile() {
    return path.join(this.root, 'window-state.json');
  },
  get proxyDir() {
    return path.join(this.root, 'proxy');
  },
  get proxyConfigFile() {
    return path.join(this.proxyDir, 'config.yaml');
  },
  get authDir() {
    return path.join(this.proxyDir, 'auths');
  },
  get proxyLogFile() {
    return path.join(this.proxyDir, 'proxy.log');
  },
};

/** The bundled proxy binary: resources/bin in a packaged app, the repo's resources/bin in dev. */
export function bundledProxyPath(): string {
  const base = app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(app.getAppPath(), 'resources', 'bin');
  return path.join(base, PROXY_EXE_NAME);
}

/** Resolves the configured override, else the bundled binary; null when neither exists. */
export function resolveProxyExecutable(override: string): string | null {
  const candidate = override.trim() || bundledProxyPath();
  return existsSync(candidate) ? candidate : null;
}

export function appIconPath(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.join(app.getAppPath(), 'resources', 'icon.png');
}
