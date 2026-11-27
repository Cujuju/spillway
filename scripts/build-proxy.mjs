// Builds cli-proxy-api from the CLIProxyAPI fork into resources/bin/<platform>-<arch>/.
// The folder uses Node's process.platform/arch names, matching electron-builder's ${platform}-${arch}
// in electron-builder.ts and bundledProxyPath() in src/main/paths.ts.
// Source checkout: CLIPROXY_SRC env var, else ../CLIProxyAPI next to this repo.
// Targets: host by default; or e.g. `pnpm proxy:build darwin-arm64 darwin-x64`, or `all`.
// --dev (used by `pnpm dev`): an unchanged fork skips the build, the contract tests leave out DEV_SKIPPED_TESTS,
// and a failed build keeps the existing binary, so a fork mid-edit never stops the dev app from launching.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitBuild } from '../appVersion.ts';
import { isUpToDate, sourceState, writeStamp } from './proxyBuildStamp.mts';

const ALL_TARGETS = ['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64'];
const GOOS = { win32: 'windows', darwin: 'darwin', linux: 'linux' };
const GOARCH = { x64: 'amd64', arm64: 'arm64' };
const DEV = '--dev';
/** Collects the Go dependencies' license files. Pinned; installed into the fork's dist/, so the build needs only Go. */
const GO_LICENSES = 'github.com/google/go-licenses/v2@v2.0.1';
/** Upstream's load test: 33 s of the 45 s contract run. Releases and `pnpm proxy:build` still run it. */
const DEV_SKIPPED_TESTS = ['TestIssue7431_LargeWeightedPoolRotatesAcrossTransientExclusionsAndCooldowns'];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.resolve(process.env.CLIPROXY_SRC ?? path.join(root, '..', 'CLIProxyAPI'));
const dev = process.argv.includes(DEV);
const args = process.argv.slice(2).filter((a) => a !== DEV);
const targets = args.includes('all') ? ALL_TARGETS : args.length ? args : [`${process.platform}-${process.arch}`];
for (const target of targets) {
  const [platform, arch] = target.split('-');
  if (!GOOS[platform] || !GOARCH[arch]) {
    console.error(`Unknown target "${target}". Use <platform>-<arch>, e.g. ${ALL_TARGETS.join(', ')}.`);
    process.exit(1);
  }
}
const forkPresent = existsSync(path.join(src, 'go.mod'));
const binaryName = (target) => (target.startsWith('win32-') ? 'cli-proxy-api.exe' : 'cli-proxy-api');
const destFor = (target) => path.join(root, 'resources', 'bin', target, binaryName(target));

/** A build's inputs besides its target: the fork's content, the Go toolchain and this script. Every build stamps it; only --dev skips. */
const buildKey = forkPresent ? JSON.stringify({
  source: sourceState(src),
  go: execFileSync('go', ['env', 'GOVERSION'], { encoding: 'utf8' }).trim(),
  script: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
}) : null;
const keyFor = (target) => `${buildKey}|${target}`;
const pending = targets.filter((target) => {
  if (!dev || !buildKey || !isUpToDate(destFor(target), keyFor(target))) return true;
  console.log(`proxy binary up to date → ${destFor(target)}`);
  return false;
});
if (!pending.length) process.exit(0);
/**
 * Licenses for modules whose release has no LICENSE file, copied from the module's repo at the commit that added it.
 * Layout: <module path>/LICENSE. go-licenses skips these modules; the files are copied in instead.
 */
const overridesDir = path.join(root, 'scripts', 'go-license-overrides');
/**
 * Built once for this machine: `go run` would build it for the target OS. It reads the target from GOOS/GOARCH.
 * Returns null when the fork checkout is missing; each target then reports that.
 */
function installGoLicenses() {
  if (!forkPresent) return null;
  const bin = path.join(src, 'dist', 'tools');
  const { GOOS: _os, GOARCH: _arch, ...hostEnv } = process.env;
  execFileSync('go', ['install', GO_LICENSES], { cwd: src, env: { ...hostEnv, GOBIN: bin }, stdio: 'inherit' });
  return path.join(bin, process.platform === 'win32' ? 'go-licenses.exe' : 'go-licenses');
}
const goLicenses = installGoLicenses();

/**
 * The fork's quota contract: credential cooldowns, usage lookups, and recovery once a lookup shows headroom.
 * Not the whole suite: unrelated timing tests flake under its full parallel load.
 */
const CONTRACT_TEST_PACKAGES = ['./sdk/cliproxy/auth/', './internal/codexusage/', './internal/claudeusage/'];
/** Runs once on this machine; no target builds when they fail. A missing checkout passes; each target reports it. */
function contractTestsPass() {
  if (!forkPresent) return true;
  const { GOOS: _os, GOARCH: _arch, ...hostEnv } = process.env;
  try {
    const skip = dev ? ['-skip', DEV_SKIPPED_TESTS.map((name) => `^${name}$`).join('|')] : [];
    execFileSync('go', ['test', ...skip, ...CONTRACT_TEST_PACKAGES], { cwd: src, env: hostEnv, stdio: 'inherit' });
    return true;
  } catch {
    return false;
  }
}
const contractTestsPassed = contractTestsPass();
const overriddenModules = readdirSync(overridesDir, { recursive: true, encoding: 'utf8' })
  .filter((f) => path.basename(f) === 'LICENSE')
  .map((f) => path.dirname(f).split(path.sep).join('/'));

/** Reports a failed target; exits unless --dev and a binary is already in place. */
function fail(message, dest) {
  if (dev && existsSync(dest)) {
    console.warn(`${message}\nKeeping the last good proxy binary at ${dest}.`);
    return;
  }
  console.error(message);
  process.exit(1);
}

/**
 * Stamps the binary like upstream's release workflow; the proxy reports these in its X-CPA-* headers.
 * Version is the newest upstream release tag in the fork, so the fork must never add its own v* tags.
 */
function ldflags() {
  const baseTag = execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*', 'HEAD'], { cwd: src, encoding: 'utf8' }).trim();
  const stamp = { Version: baseTag, Commit: gitBuild(src), BuildDate: new Date().toISOString() };
  return ['-s', '-w', ...Object.entries(stamp).map(([name, value]) => `-X main.${name}=${value}`)].join(' ');
}

for (const target of pending) {
  const [platform, arch] = target.split('-');
  const dest = destFor(target);
  const built = path.join(src, 'dist', target, path.basename(dest));
  if (!forkPresent) {
    fail(`CLIProxyAPI source not found at ${src}. Set CLIPROXY_SRC to the checkout.`, dest);
    continue;
  }
  if (!contractTestsPassed) {
    fail(`CLIProxyAPI contract tests failed (${CONTRACT_TEST_PACKAGES.join(' ')}); the proxy is not built.`, dest);
    continue;
  }
  mkdirSync(path.dirname(built), { recursive: true });
  mkdirSync(path.dirname(dest), { recursive: true });
  // CGO off: a pure-Go binary cross-compiles from any host. Go ad-hoc signs darwin/arm64 output.
  const env = { ...process.env, GOOS: GOOS[platform], GOARCH: GOARCH[arch], CGO_ENABLED: '0' };
  // MIT requires the notice wherever the binary ships; electron-builder.ts packages it from here.
  const license = path.join(src, 'LICENSE');
  if (!existsSync(license)) {
    fail(`CLIProxyAPI LICENSE not found at ${license}; the binary cannot ship without it.`, dest);
    continue;
  }
  copyFileSync(license, path.join(path.dirname(dest), 'LICENSE'));
  // Every compiled-in Go module's license; electron-builder.ts ships the folder. Fails on a module with no license.
  const depLicenses = path.join(path.dirname(dest), 'licenses');
  const ownModule = /^module\s+(\S+)/m.exec(readFileSync(path.join(src, 'go.mod'), 'utf8'))?.[1] ?? '';
  const ignores = [ownModule, ...overriddenModules].flatMap((m) => ['--ignore', m]);
  try {
    execFileSync(goLicenses, ['save', './cmd/server', '--save_path', depLicenses, '--force', ...ignores], { cwd: src, env, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    // go-licenses logs many warnings; its fatal reason is the last line.
    const reason = err.stderr?.toString().trim().split('\n').at(-1) ?? String(err);
    fail(`Collecting Go dependency licenses for ${target} failed: ${reason}`, dest);
    continue;
  }
  for (const m of overriddenModules) cpSync(path.join(overridesDir, m), path.join(depLicenses, m), { recursive: true });
  try {
    execFileSync('go', ['build', '-trimpath', '-ldflags', ldflags(), '-o', built, './cmd/server'], { cwd: src, env, stdio: 'inherit' });
    // EBUSY on Windows when a proxy from this binary is still running.
    copyFileSync(built, dest);
    writeStamp(dest, keyFor(target));
  } catch (err) {
    fail(`Proxy build for ${target} failed: ${err instanceof Error ? err.message : err}`, dest);
    continue;
  }
  console.log(`proxy binary → ${dest}`);
}
