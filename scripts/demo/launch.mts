/** The built app on a throwaway profile, an empty home (no client logs or T3 Code state) and the fake proxy. */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate, userConfigYaml, type DemoData } from './fixtures.mts';
import { startDemoProxy, type DemoProxy } from './server.mts';
import { startDemoClickHouse } from './clickhouse.mts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The maintainer's own theme and window size: the demo shows the app as it is used. */
export const DARK_THEME = 'tonal';
export const DEMO_WINDOW = { width: 1842, height: 1179 };

const tile = (id: string) => ({ kind: 'tile', id });
const split = (dir: 'row' | 'column', sizes: number[], ...children: unknown[]) => ({ kind: 'split', dir, sizes, children });
/** The maintainer's Activity board (sizes in px where resized): Rhythm beside Tokens over Heatmap, Models beside Clients, then Model and effort. */
const DEMO_BOARD = {
  version: 2,
  tiles: split('column', [432, 292, 593],
    split('row', [1, 0.695], tile('rhythm'), split('column', [188, 236], tile('trend'), tile('heatmap'))),
    split('row', [1, 1], tile('models'), tile('clients')),
    tile('efforts')),
  panels: {
    rhythm: { kind: 'rhythm', metric: 'cost' },
    trend: { kind: 'trend', metric: 'tokens' },
    heatmap: { kind: 'heatmap', metric: 'tokens' },
    models: { kind: 'models', metric: 'cost' },
    clients: { kind: 'clients', metric: 'cost' },
    efforts: { kind: 'efforts', metric: 'cost' },
  },
  heightPx: 1333,
};

export interface DemoApp {
  child: ChildProcess;
  proxy: DemoProxy;
  clickhouse?: Awaited<ReturnType<typeof startDemoClickHouse>>;
  exited: Promise<void>;
  /** Quits the app if still running, stops the fake proxy and deletes the throwaway folders. */
  close(): Promise<void>;
}

export interface DemoOptions {
  theme?: string;
  /** Chrome DevTools Protocol port for scripted control (screenshots). */
  debuggingPort?: number;
  clickhouse?: boolean;
}

/** The maintainer's UI settings; behaviour that would reach past the throwaway profile (login item, tray, notifications, updates) stays off. */
function writeProfile(dir: string, theme: string, data: DemoData): void {
  const settings = {
    general: { theme, launchAtLogin: false, startMinimized: false, closeToTray: false, sidebarCollapsed: false },
    proxy: { autoStart: true },
    dashboard: { showEmails: false, forecastHours: 168, drainLookbackHours: 24, accountSort: 'reset' },
    activity: { board: DEMO_BOARD },
    trayIcons: { enabled: false },
    notifications: { limitHit: false, limitReset: false, accountSwitched: false, proxyCrashed: false },
    updates: { autoCheck: false },
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2));
  writeFileSync(path.join(dir, 'window-state.json'), JSON.stringify({ ...DEMO_WINDOW, maximized: false }));
  // The app rebuilds window summaries and observed spans from these samples (historyStore.ts).
  writeFileSync(path.join(dir, 'usage-history.json'), JSON.stringify(data.history));
  mkdirSync(path.join(dir, 'proxy'), { recursive: true });
  writeFileSync(path.join(dir, 'proxy', 'config.user.yaml'), userConfigYaml());
}

/** The client-home variables the app honours (clientHomes.ts); unset so the fake home applies. */
const CLIENT_HOME_VARS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'];
/** Electron's appData folder relative to the home folder, per platform. */
const APP_DATA_UNDER_HOME: Partial<Record<NodeJS.Platform, string[]>> = { win32: ['AppData', 'Roaming'], darwin: ['Library', 'Application Support'], linux: ['.config'] };

export async function launchDemo({ theme = DARK_THEME, debuggingPort, clickhouse: withClickHouse }: DemoOptions = {}): Promise<DemoApp> {
  const data = generate(Date.now());
  const scratch = mkdtempSync(path.join(tmpdir(), 'spillway-demo-'));
  const profile = path.join(scratch, 'profile');
  const home = path.join(scratch, 'home');
  // Electron resolves appData under the home folder; without it a dev build fails at load. It also keeps production's config unreachable.
  mkdirSync(path.join(home, ...APP_DATA_UNDER_HOME[process.platform] ?? []), { recursive: true });
  writeProfile(profile, theme, data);
  const proxy = await startDemoProxy(data);
  const clickhouse = withClickHouse ? await startDemoClickHouse() : undefined;

  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  if (process.platform === 'linux') env.XDG_CONFIG_HOME = path.join(home, '.config');
  for (const name of [...CLIENT_HOME_VARS, 'ELECTRON_RUN_AS_NODE']) delete env[name];
  const electron = createRequire(import.meta.url)('electron') as string;
  const args = ['.', `--user-data-dir=${profile}`, `--proxy-endpoint=${proxy.endpoint}`];
  if (debuggingPort) args.push(`--remote-debugging-port=${debuggingPort}`);
  const child = spawn(electron, args, { cwd: ROOT, env, stdio: 'inherit' });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));

  return {
    child,
    proxy,
    clickhouse,
    exited,
    async close() {
      if (child.exitCode === null) {
        child.kill();
        await exited;
      }
      await proxy.close();
      await clickhouse?.close();
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}
