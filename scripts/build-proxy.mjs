// Builds cli-proxy-api.exe from the CLIProxyAPI fork and copies it to resources/bin.
// Source checkout: CLIPROXY_SRC env var, else ../CLIProxyAPI next to this repo.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.resolve(process.env.CLIPROXY_SRC ?? path.join(root, '..', 'CLIProxyAPI'));
const outDir = path.join(root, 'resources', 'bin');
const exe = path.join(outDir, 'cli-proxy-api.exe');

if (!existsSync(path.join(src, 'go.mod'))) {
  console.error(`CLIProxyAPI source not found at ${src}. Set CLIPROXY_SRC to the checkout.`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const built = path.join(src, 'dist', 'cli-proxy-api.exe');
mkdirSync(path.dirname(built), { recursive: true });
execFileSync('go', ['build', '-trimpath', '-ldflags', '-s -w', '-o', built, './cmd/server'], { cwd: src, stdio: 'inherit' });
copyFileSync(built, exe);
console.log(`proxy binary → ${exe}`);
