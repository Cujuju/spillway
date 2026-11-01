/**
 * Signs and publishes updates from this machine (docs/releasing.md):
 *   pnpm release keygen | nightly [--dry-run] | promote <version> [--dry-run]
 * The private key stays outside the repo: $SPILLWAY_UPDATE_KEY or ~/.config/spillway/update_key.
 */
import { execFileSync, execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runReleaseCli } from '@cujuju/electron-updates/node';
import { appVersion } from '../appVersion.ts';
import { APP_NAME } from '../src/shared/app.ts';
import { UPDATE_REPO, UPDATE_SIGNATURE_CONTEXT } from '../src/shared/updateFeed.ts';
import { capture, IMAGES_DIR } from './screenshots.mts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The macOS architectures electron-builder.ts packages. */
const MAC_ARCHS = ['arm64', 'x64'];

/** Nightlies ship the proxy and toolkit from these siblings; they must match their latest pushed commit. */
const SIBLINGS = ['solidjs-toolkit', 'CLIProxyAPI'];
if (process.argv[2] === 'nightly') {
  const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  for (const name of SIBLINGS) {
    const dir = path.join(ROOT, '..', name);
    git(dir, ['fetch', 'origin']);
    if (git(dir, ['status', '--porcelain', '--untracked-files=no']) || git(dir, ['rev-parse', 'HEAD']) !== git(dir, ['rev-parse', 'origin/HEAD'])) {
      console.error(`${dir} is not clean at its latest pushed commit; build from it, then release. (node scripts/nightly.mts run does this for you.)`);
      process.exit(1);
    }
  }
}

/** A stable release refreshes the README screenshots from fake data, then commits and pushes them to main. */
const README_BRANCH = 'main';
if (process.argv[2] === 'promote' && !process.argv.includes('--dry-run')) {
  const git = (args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  if (git(['branch', '--show-current']) !== README_BRANCH) {
    console.error(`Promote from ${README_BRANCH}: it commits and pushes the refreshed screenshots there.`);
    process.exit(1);
  }
  execSync('pnpm build', { cwd: ROOT, stdio: 'inherit' });
  await capture();
  if (git(['status', '--porcelain', '--', IMAGES_DIR])) {
    git(['add', '--', IMAGES_DIR]);
    git(['commit', '-m', `docs: refresh screenshots for ${process.argv[3] ?? 'release'}`, '--', IMAGES_DIR]);
  }
  // A rejected push (main behind origin) stops the promote before anything is published.
  execFileSync('git', ['push', 'origin', README_BRANCH], { cwd: ROOT, stdio: 'inherit' });
}

await runReleaseCli({
  appName: APP_NAME,
  repo: UPDATE_REPO,
  tagSourceCommit: true,
  signatureContext: UPDATE_SIGNATURE_CONTEXT,
  dist: path.join(ROOT, 'dist'),
  publicKeyFile: path.join(ROOT, 'resources', 'update-public-key.pem'),
  keyFile: process.env.SPILLWAY_UPDATE_KEY || path.join(os.homedir(), '.config', 'spillway', 'update_key'),
  version: () => appVersion(ROOT),
  archs: { win32: ['x64'], darwin: MAC_ARCHS },
  // electron-builder.ts artifact names.
  updateSource: (platform, arch, v) => (platform === 'win32' ? `${APP_NAME}-Setup-${v}.exe` : `${arch === 'arm64' ? 'mac-arm64' : 'mac'}/${APP_NAME}.app`),
  // Disk images: the first install on a Mac. SPILLWAY_UPDATE_ONLY (nightly on push) publishes update files only.
  extraFiles: (platform, v) => (platform === 'darwin' && !process.env.SPILLWAY_UPDATE_ONLY ? MAC_ARCHS.map((arch) => `${APP_NAME}-${v}-${arch}.dmg`) : []),
});
