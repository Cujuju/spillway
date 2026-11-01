import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const KEY_BYTES = 32;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Gitignored; kept apart from out/, which holds the production build. */
const DEV_OUT_DIR = 'out-dev';
// Matches TRANSFER_EXIT.appRunning in the app's headless transfer mode.
const APP_RUNNING = 20;
let prodOverride: string | undefined;
function installedProd(): string {
  if (prodOverride) return path.resolve(prodOverride);
  if (process.platform === 'darwin') return '/Applications/Spillway.app/Contents/MacOS/Spillway';
  if (process.platform !== 'win32') throw new Error('Data merge supports Windows and macOS');
  if (!process.env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is not set');
  return path.join(process.env.LOCALAPPDATA, 'Programs', 'Spillway', 'Spillway.exe');
}
/** Spillway Dev runs from the repo: build its main process with the dev identity, outside out/. */
function buildDev(env: NodeJS.ProcessEnv): string[] {
  execSync(`pnpm exec electron-vite build --outDir ${DEV_OUT_DIR}`, { cwd: ROOT, env: { ...env, SPILLWAY_DEV_BUILD: '1' }, stdio: 'inherit' });
  return [createRequire(import.meta.url)('electron') as string, path.join(ROOT, DEV_OUT_DIR, 'main', 'index.js')];
}
async function main(): Promise<void> {
  for (const arg of process.argv.slice(2)) {
    const match = /^--prod=(.+)$/.exec(arg);
    if (!match) throw new Error(`Unknown argument: ${arg}. Use --prod=<exe>`);
    prodOverride = match[1];
  }

  const baseEnv: NodeJS.ProcessEnv = { ...process.env };
  delete baseEnv.ELECTRON_RUN_AS_NODE;
  const prod = { name: 'Spillway', command: [installedProd()] };
  if (!existsSync(prod.command[0]!)) throw new Error(`Missing Spillway: ${prod.command[0]}. Install a build supporting data transfer, or pass --prod=<exe>.`);
  const dev = { name: 'Spillway Dev', command: buildDev(baseEnv) };
  const env: NodeJS.ProcessEnv = { ...baseEnv, SPILLWAY_TRANSFER_KEY: randomBytes(KEY_BYTES).toString('hex') };
  const dir = await mkdtemp(path.join(tmpdir(), 'spillway-merge-'));
  const run = (app: { name: string; command: string[] }, mode: string, file: string): Promise<void> => new Promise((resolve, reject) => {
    const [exe, ...args] = app.command;
    const child = spawn(exe!, [...args, `--data-${mode}=${file}`], { env, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === APP_RUNNING) reject(new Error(`Quit ${app.name} first`));
      else if (code !== 0) reject(new Error(`${app.name} ${mode} failed (${signal ?? code})`));
      else resolve();
    });
  });
  try {
    const prodFile = path.join(dir, 'prod.enc');
    const devFile = path.join(dir, 'dev.enc');
    await run(prod, 'export', prodFile);
    await run(dev, 'export', devFile);
    await run(dev, 'import', prodFile);
    await run(prod, 'import', devFile);
    console.log('Merged activity and account usage history in both directions. Backups are listed above.');
  } finally { await rm(dir, { recursive: true, force: true }); }
}
try { await main(); }
catch (err) { console.error(String(err)); process.exitCode = 1; }
