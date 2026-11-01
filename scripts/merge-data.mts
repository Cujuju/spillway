import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const KEY_BYTES = 32;
// Matches TRANSFER_EXIT.appRunning in the app's headless transfer mode.
const APP_RUNNING = 20;
const overrides = new Map<string, string>();
function installedApp(dev: boolean): string {
  const override = overrides.get(dev ? 'dev' : 'prod');
  if (override) return path.resolve(override);
  const name = dev ? 'Spillway Dev' : 'Spillway';
  if (process.platform === 'darwin') return `/Applications/${name}.app/Contents/MacOS/${name}`;
  if (process.platform !== 'win32') throw new Error('Data merge supports Windows and macOS');
  if (!process.env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is not set');
  return path.join(process.env.LOCALAPPDATA, 'Programs', dev ? 'spillway-dev' : 'Spillway', `${name}.exe`);
}
async function main(): Promise<void> {
  for (const arg of process.argv.slice(2)) {
    const match = /^--(prod|dev)=(.+)$/.exec(arg);
    if (!match) throw new Error(`Unknown argument: ${arg}. Use --prod=<exe> or --dev=<exe>`);
    overrides.set(match[1]!, match[2]!);
  }

  const prod = { name: 'Spillway', exe: installedApp(false) };
  const dev = { name: 'Spillway Dev', exe: installedApp(true) };
  for (const app of [prod, dev]) if (!existsSync(app.exe)) throw new Error(`Missing ${app.name}: ${app.exe}. Install a build supporting data transfer, or use an executable override.`);
  const env: NodeJS.ProcessEnv = { ...process.env, SPILLWAY_TRANSFER_KEY: randomBytes(KEY_BYTES).toString('hex') };
  delete env.ELECTRON_RUN_AS_NODE;
  const dir = await mkdtemp(path.join(tmpdir(), 'spillway-merge-'));
  const run = (app: { name: string; exe: string }, mode: string, file: string): Promise<void> => new Promise((resolve, reject) => {
    const child = spawn(app.exe, [`--data-${mode}=${file}`], { env, stdio: 'inherit', windowsHide: true });
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
