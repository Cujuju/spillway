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
import { capture, IMAGES_DIR } from './demo/screenshots.mts';
import { assertReleaseSiblings, ensureNightlyRelease, installerFiles, RELEASE_ARCHS, releaseDetails } from './releaseShared.mts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Nightlies ship the proxy and toolkit from these siblings; they must match their latest pushed commit. */
if (process.argv[2] === 'nightly') {
  assertReleaseSiblings();
  const git = (args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  git(['fetch', '--tags', 'origin']);
  if (git(['status', '--porcelain', '--untracked-files=no']) || !git(['branch', '-r', '--contains', 'HEAD'])) throw new Error('Release a clean, pushed commit.');
  ensureNightlyRelease(releaseDetails(), process.argv.includes('--dry-run'));
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
  archs: RELEASE_ARCHS,
  // electron-builder.ts artifact names.
  updateSource: (platform, arch, v) => {
    if (platform === 'win32') return `${APP_NAME}-Setup-${v}.exe`;
    if (platform === 'linux') return `${APP_NAME}-${v}-${arch}.AppImage`;
    return `${arch === 'arm64' ? 'mac-arm64' : 'mac'}/${APP_NAME}.app`;
  },
  // First-install files accompany manual Mac releases; scheduled CI nightlies publish update files only.
  extraFiles: (platform, v) => (platform === 'darwin' && !process.env.SPILLWAY_UPDATE_ONLY ? installerFiles(platform, v) : []),
});
