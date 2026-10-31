// `pnpm package:dev [--no-install]`: builds Spillway Dev, which installs beside production (src/shared/app.ts),
// into dist-dev/. On Windows it then runs the one-click installer, which updates the Start Menu entry and opens the app.
import { execSync, spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist-dev');
const env = { ...process.env, SPILLWAY_DEV_BUILD: '1' };

// Fixed command strings: `pnpm` is a .cmd shim on Windows, which needs a shell.
execSync('pnpm exec electron-vite build', { cwd: root, env, stdio: 'inherit' });
execSync('pnpm exec electron-builder --publish never', { cwd: root, env, stdio: 'inherit' });

if (process.platform !== 'win32') {
  console.log(`package-dev: built into ${outDir}`);
  process.exit(0);
}

const installers = readdirSync(outDir)
  .filter((f) => /^Spillway-Dev-Setup-.*\.exe$/.test(f))
  .map((f) => path.join(outDir, f))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
const installer = installers[0];
if (!installer) throw new Error(`No Spillway-Dev-Setup-*.exe in ${outDir}`);

if (process.argv.includes('--no-install')) {
  console.log(`package-dev: installer at ${installer}`);
} else {
  console.log(`package-dev: installing ${path.basename(installer)}`);
  spawn(installer, [], { detached: true, stdio: 'ignore' }).unref();
}
