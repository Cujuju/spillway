/** `pnpm demo`: the built app on a throwaway profile, an empty home (no client logs or T3 Code state) and the fake proxy. */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate, userConfigYaml, type DemoData } from './fixtures.mts';
import { startDemoProxy, type DemoProxy } from './server.mts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DARK_THEME = 'dracula';

export interface DemoApp {
  child: ChildProcess;
  proxy: DemoProxy;
  exited: Promise<void>;
  /** Quits the app if still running, stops the fake proxy and deletes the throwaway folders. */
  close(): Promise<void>;
}

export interface DemoOptions {
  theme?: string;
  /** Chrome DevTools Protocol port for scripted control (screenshots). */
  debuggingPort?: number;
}

function writeProfile(dir: string, theme: string, data: DemoData): void {
  const settings = {
    general: { theme, launchAtLogin: false, startMinimized: false, closeToTray: false },
    proxy: { autoStart: true },
    dashboard: { showEmails: true },
    trayIcons: { enabled: false },
    notifications: { limitHit: false, limitReset: false, accountSwitched: false, proxyCrashed: false },
    updates: { autoCheck: false },
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2));
  // The app rebuilds window summaries and observed spans from these samples (historyStore.ts).
  writeFileSync(path.join(dir, 'usage-history.json'), JSON.stringify(data.history));
  mkdirSync(path.join(dir, 'proxy'), { recursive: true });
  writeFileSync(path.join(dir, 'proxy', 'config.user.yaml'), userConfigYaml());
}

/** The client-home variables the app honours (clientHomes.ts); unset so the fake home applies. */
const CLIENT_HOME_VARS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'];
/** Electron's appData folder relative to the home folder, per platform. */
const APP_DATA_UNDER_HOME: Partial<Record<NodeJS.Platform, string[]>> = { win32: ['AppData', 'Roaming'], darwin: ['Library', 'Application Support'] };

export async function launchDemo({ theme = DARK_THEME, debuggingPort }: DemoOptions = {}): Promise<DemoApp> {
  const data = generate(Date.now());
  const scratch = mkdtempSync(path.join(tmpdir(), 'spillway-demo-'));
  const profile = path.join(scratch, 'profile');
  const home = path.join(scratch, 'home');
  // Electron resolves appData under the home folder; without it a dev build fails at load. It also keeps production's config unreachable.
  mkdirSync(path.join(home, ...APP_DATA_UNDER_HOME[process.platform] ?? []), { recursive: true });
  writeProfile(profile, theme, data);
  const proxy = await startDemoProxy(data);

  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  for (const name of [...CLIENT_HOME_VARS, 'ELECTRON_RUN_AS_NODE']) delete env[name];
  const electron = createRequire(import.meta.url)('electron') as string;
  const args = ['.', `--user-data-dir=${profile}`, `--proxy-endpoint=${proxy.endpoint}`];
  if (debuggingPort) args.push(`--remote-debugging-port=${debuggingPort}`);
  const child = spawn(electron, args, { cwd: ROOT, env, stdio: 'inherit' });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));

  return {
    child,
    proxy,
    exited,
    async close() {
      if (child.exitCode === null) {
        child.kill();
        await exited;
      }
      await proxy.close();
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await launchDemo({ theme: process.argv[2] });
  console.log(`demo: fake proxy at ${app.proxy.endpoint}, ${app.proxy.eventCount} requests`);
  await app.exited;
  await app.close();
}
