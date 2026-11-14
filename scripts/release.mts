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
import { assertReleaseSiblings, ensureNightlyRelease, installerFiles, RELEASE_ARCHS, releaseDetails, updateSource } from './releaseShared.mts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Nightlies ship the proxy and toolkit from these siblings; they must match their latest pushed commit. */
if (process.argv[2] === 'nightly') {
  assertReleaseSiblings();
  const git = (args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  git(['fetch', '--tags', 'origin']);
  if (git(['status', '--porcelain', '--untracked-files=no']) || !git(['branch', '-r', '--contains', 'HEAD'])) throw new Error('Release a clean, pushed commit.');
  ensureNightlyRelease(releaseDetails(), process.argv.includes('--dry-run'));
}

/** A stable release refreshes the README screenshots and opens an auto-merge PR; promote needn't wait, its tag stays on the nightly's commit. */
const README_BRANCH = 'main';
if (process.argv[2] === 'promote' && !process.argv.includes('--dry-run')) {
  const git = (args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  const version = process.argv[3]?.replace(/^v/, '');
  if (!version) {
    console.error('usage: promote <version> [--dry-run]');
    process.exit(1);
  }
  git(['fetch', 'origin', README_BRANCH]);
  if (git(['branch', '--show-current']) !== README_BRANCH || git(['rev-parse', 'HEAD']) !== git(['rev-parse', `origin/${README_BRANCH}`])) {
    console.error(`Promote from ${README_BRANCH} at origin/${README_BRANCH}: the screenshot PR is based on it.`);
    process.exit(1);
  }
  execSync('pnpm build', { cwd: ROOT, stdio: 'inherit' });
  await capture();
  if (git(['status', '--porcelain', '--', IMAGES_DIR])) {
    const branch = `release/screenshots-v${version}`;
    const title = `docs: refresh screenshots for v${version}`;
    // Any failure here (branch, commit, push, PR) stops the promote before anything is published.
    git(['switch', '-C', branch]);
    try {
      git(['add', '--', IMAGES_DIR]);
      git(['commit', '-m', title, '--', IMAGES_DIR]);
      // A rerun replaces this release's earlier screenshots.
      execFileSync('git', ['push', '--force', '-u', 'origin', branch], { cwd: ROOT, stdio: 'inherit' });
    } finally {
      git(['switch', README_BRANCH]);
    }
    const gh = (args: string[]) => execFileSync('gh', args, { cwd: ROOT, encoding: 'utf8' }).trim();
    const open = gh(['pr', 'list', '--repo', UPDATE_REPO, '--head', branch, '--state', 'open', '--json', 'url', '--jq', '.[0].url']);
    const url = open || gh(['pr', 'create', '--repo', UPDATE_REPO, '--base', README_BRANCH, '--head', branch, '--title', title,
      '--body', `Demo screenshots refreshed by \`pnpm release promote ${version}\`. The release doesn't depend on it.`]);
    console.log(`Screenshot PR: ${url}`);
    try {
      gh(['pr', 'merge', url, '--auto', '--squash']);
    } catch {
      console.warn(`Couldn't enable auto-merge; merge ${url} by hand.`);
    }
  }
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
  updateSource,
  // Mac DMG/ZIP files accompany local nightlies; CI attaches them after promotion.
  extraFiles: (platform, v) => (platform === 'darwin' && !process.env.SPILLWAY_UPDATE_ONLY ? installerFiles(platform, v) : []),
});
