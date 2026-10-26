import { app } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const USER_CONFIG_NAME = 'config.user.yaml';

export const PROXY_EXE_NAME = process.platform === 'win32' ? 'cli-proxy-api.exe' : 'cli-proxy-api';

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
  /** Per-day request logs and daily totals (activityLog.ts). */
  get activityDir() {
    return path.join(this.root, 'activity');
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
  /** User overlay merged under the app-owned keys; see proxyConfig.ts. */
  get proxyUserConfigFile() {
    return path.join(this.proxyDir, USER_CONFIG_NAME);
  },
  get authDir() {
    return path.join(this.proxyDir, 'auths');
  },
  get proxyLogFile() {
    return path.join(this.proxyDir, 'proxy.log');
  },
};

/**
 * The bundled proxy binary. electron-builder copies resources/bin/<platform>-<arch> to bin in a packaged app;
 * dev reads the repo folder for this machine (scripts/build-proxy.mjs writes it).
 */
export function bundledProxyPath(): string {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'bin')
    : path.join(app.getAppPath(), 'resources', 'bin', `${process.platform}-${process.arch}`);
  return path.join(base, PROXY_EXE_NAME);
}

/** Resolves the configured override, else the bundled binary; null when neither exists. */
export function resolveProxyExecutable(override: string): string | null {
  const candidate = override.trim() || bundledProxyPath();
  return existsSync(candidate) ? candidate : null;
}

const resourcePath = (file: string) =>
  app.isPackaged ? path.join(process.resourcesPath, file) : path.join(app.getAppPath(), 'resources', file);

/** 256 px PNG: notifications and the macOS menu bar. */
export const appIconPath = () => resourcePath('icon.png');

/** Codex's key command entry (resources/print-client-key.cjs); a plain file, so Electron can run it as Node. */
export const printClientKeyLauncherPath = () => resourcePath('print-client-key.cjs');

/** Window and tray icon. Windows gets the .ico: its pre-resampled 16-32 px sizes are sharper than Electron scaling the 256 px PNG. */
export const shellIconPath = () => resourcePath(process.platform === 'win32' ? 'icon.ico' : 'icon.png');
