/** The built app on a throwaway profile, an empty home (no client logs or T3 Code state) and the fake proxy. */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCOUNTS, generate, userConfigYaml, type DemoData } from './fixtures.mts';
import { startDemoProxy, type DemoProxy } from './server.mts';
import { startDemoClickHouse, type DemoClickHouseRow } from './clickhouse.mts';
import { OLDER_DAYS_WINDOW } from '../../src/shared/activityOlder.ts';
import type { ActivityEvent } from '../../src/shared/types.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The maintainer's own theme and window size: the demo shows the app as it is used. */
export const DARK_THEME = 'tonal';
export const DEMO_WINDOW = { width: 1842, height: 1179 };
// Pinned so the seeded ClickHouse rows stay older than retention if the app default changes.
const DEMO_REQUEST_RETENTION_DAYS = 35;
const DEMO_OLDER_DAYS = 2 * OLDER_DAYS_WINDOW;
const DEMO_REQUEST_HOUR = 10;

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
    activity: { board: DEMO_BOARD, retentionDays: DEMO_REQUEST_RETENTION_DAYS },
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

function olderFacts(data: DemoData): DemoClickHouseRow[] {
  const firstLocal = new Date(data.events.reduce((first, event) => Math.min(first, Date.parse(event.at)), data.now));
  const cutoff = new Date(data.now);
  cutoff.setDate(cutoff.getDate() - (DEMO_REQUEST_RETENTION_DAYS - 1));
  const end = firstLocal < cutoff ? firstLocal : cutoff;
  const rows: DemoClickHouseRow[] = [];
  const add = (kind: 'request' | 'total', at: string, key: string, record: unknown) => {
    rows.push({ kind, at, record_key: key, source_id: 'demo-history', seq: rows.length + 1, record_json: JSON.stringify(record) });
  };
  for (let i = 1; i <= DEMO_OLDER_DAYS; i++) {
    const date = new Date(end);
    date.setDate(date.getDate() - i);
    date.setHours(DEMO_REQUEST_HOUR, 0, 0, 0);
    const at = date.toISOString();
    const day = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
    const account = ACCOUNTS[i % ACCOUNTS.length]!;
    const requestId = `older-demo-${i}`;
    const dimensions = { provider: account.provider, model: account.models[0]!, authIndex: account.authIndex,
      source: 'proxy' as const, client: account.userAgent.split('/')[0]! };
    const tokens = { inputTokens: 1200, outputTokens: 350, cachedTokens: 400, cacheWriteTokens: 0 };
    const event: ActivityEvent = { ...dimensions, ...tokens, at, requestId, upstreamId: null, selectionId: null,
      stream: true, failed: false, statusCode: 200, error: null, latencyMs: null, ttftMs: null, sessionId: null,
      movedFrom: null, userAgent: account.userAgent };
    add('request', at, requestId, event);
    const key = `older-demo-total-${i}`;
    add('total', at, key, { key, total: { day, start: date.getTime(), ...dimensions, ...tokens, requests: 1, costUsd: 0.01 } });
  }
  return rows;
}

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
  clickhouse?.addRows(olderFacts(data));

  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  if (process.platform === 'linux') env.XDG_CONFIG_HOME = path.join(home, '.config');
  for (const name of [...CLIENT_HOME_VARS, 'ELECTRON_RUN_AS_NODE']) delete env[name];
  const electron = createRequire(import.meta.url)('electron') as string;
  const args = ['.', `--user-data-dir=${profile}`, `--proxy-endpoint=${proxy.endpoint}`];
  // The throwaway home has no login keychain, so macOS would block startup on a Keychain prompt; Chromium's mock keychain stands in.
  if (process.platform === 'darwin') args.push('--use-mock-keychain');
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
