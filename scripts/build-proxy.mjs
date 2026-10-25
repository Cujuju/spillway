// Builds cli-proxy-api from the CLIProxyAPI fork into resources/bin/<platform>-<arch>/.
// The folder uses Node's process.platform/arch names, matching electron-builder's ${platform}-${arch}
// in electron-builder.yml and bundledProxyPath() in src/main/paths.ts.
// Source checkout: CLIPROXY_SRC env var, else ../CLIProxyAPI next to this repo.
// Targets: host by default; or e.g. `pnpm proxy:build darwin-arm64 darwin-x64`, or `all`.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ALL_TARGETS = ['win32-x64', 'darwin-arm64', 'darwin-x64'];
const GOOS = { win32: 'windows', darwin: 'darwin', linux: 'linux' };
const GOARCH = { x64: 'amd64', arm64: 'arm64' };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.resolve(process.env.CLIPROXY_SRC ?? path.join(root, '..', 'CLIProxyAPI'));
const args = process.argv.slice(2);
const targets = args.includes('all') ? ALL_TARGETS : args.length ? args : [`${process.platform}-${process.arch}`];

if (!existsSync(path.join(src, 'go.mod'))) {
  console.error(`CLIProxyAPI source not found at ${src}. Set CLIPROXY_SRC to the checkout.`);
  process.exit(1);
}

for (const target of targets) {
  const [platform, arch] = target.split('-');
  if (!GOOS[platform] || !GOARCH[arch]) {
    console.error(`Unknown target "${target}". Use <platform>-<arch>, e.g. ${ALL_TARGETS.join(', ')}.`);
    process.exit(1);
  }
  const name = platform === 'win32' ? 'cli-proxy-api.exe' : 'cli-proxy-api';
  const built = path.join(src, 'dist', target, name);
  const outDir = path.join(root, 'resources', 'bin', target);
  mkdirSync(path.dirname(built), { recursive: true });
  mkdirSync(outDir, { recursive: true });
  // CGO off: a pure-Go binary cross-compiles from any host. Go ad-hoc signs darwin/arm64 output.
  const env = { ...process.env, GOOS: GOOS[platform], GOARCH: GOARCH[arch], CGO_ENABLED: '0' };
  execFileSync('go', ['build', '-trimpath', '-ldflags', '-s -w', '-o', built, './cmd/server'], { cwd: src, env, stdio: 'inherit' });
  copyFileSync(built, path.join(outDir, name));
  console.log(`proxy binary → ${path.join(outDir, name)}`);
}
