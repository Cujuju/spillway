import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { appVersion } from '../appVersion.ts';
import { APP_NAME } from '../src/shared/app.ts';
import { UPDATE_REPO } from '../src/shared/updateFeed.ts';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const RELEASE_ARCHS = { win32: ['x64'], darwin: ['arm64', 'x64'], linux: ['x64'] };
export type ReleasePlatform = keyof typeof RELEASE_ARCHS;
export const BUILD_MATRIX = [
  { os: 'windows-latest', platform: 'win32', proxyTargets: 'win32-x64' },
  { os: 'macos-latest', platform: 'darwin', proxyTargets: 'darwin-arm64 darwin-x64' },
  { os: 'ubuntu-latest', platform: 'linux', proxyTargets: 'linux-x64' },
] as const;

export const git = (args: string[], cwd = ROOT): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
export const gh = (args: string[]): string => execFileSync('gh', [...args, '--repo', UPDATE_REPO], { encoding: 'utf8' }).trim();

export function releaseDetails(ref = 'HEAD', cwd = ROOT) {
  const sha = git(['rev-parse', `${ref}^{commit}`], cwd);
  const version = appVersion(cwd, sha);
  const title = `${APP_NAME} ${version}`;
  return { sha, version, tag: `v${version}`, title, notes: `${title} nightly` };
}

export interface ReleaseView {
  tagName: string;
  isPrerelease: boolean;
  assets: { name: string }[];
}

export function releaseView(tag: string): ReleaseView | null {
  try {
    const release = JSON.parse(execFileSync('gh', ['api', `repos/${UPDATE_REPO}/releases/tags/${encodeURIComponent(tag)}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) as { tag_name: string; prerelease: boolean; assets: { name: string }[] };
    return { tagName: release.tag_name, isPrerelease: release.prerelease, assets: release.assets };
  } catch (err) {
    if ((err as { stderr?: Buffer }).stderr?.toString().includes('HTTP 404')) return null;
    throw err;
  }
}

export function installerFiles(platform: ReleasePlatform, version: string): string[] {
  if (platform === 'win32') return [`${APP_NAME}-Setup-${version}.exe`];
  if (platform === 'linux') return [`${APP_NAME}-${version}-x64.AppImage`];
  return RELEASE_ARCHS.darwin.flatMap((arch) => [`${APP_NAME}-${version}-${arch}.dmg`, `${APP_NAME}-${version}-${arch}-mac.zip`]);
}

/** Used by both the CLI and CI planner before any platform uploads. */
export function ensureNightlyRelease(details: ReturnType<typeof releaseDetails>, dryRun = false): ReleaseView | null {
  const existing = releaseView(details.tag);
  if (existing) {
    if (!existing.isPrerelease) throw new Error(`${details.tag} is already stable`);
    if (git(['rev-list', '-n', '1', details.tag]) !== details.sha) throw new Error(`${details.tag} names another commit`);
    return existing;
  }
  const args = ['release', 'create', details.tag, '--prerelease', '--title', details.title, '--notes', details.notes, '--target', details.sha];
  if (dryRun) console.log(`gh ${[...args, '--repo', UPDATE_REPO].map((a) => JSON.stringify(a)).join(' ')}`);
  else gh(args);
  return null;
}

export function nightlyTarget(main: string, released: string | null, newest: ReleaseView | null, force: boolean) {
  const platforms = Object.keys(RELEASE_ARCHS) as ReleasePlatform[];
  const missing = platforms.filter((p) => !newest?.assets.some((a) => a.name === `update-${p}.json`));
  if (!force && main === released && newest?.isPrerelease && missing.length) return { sha: main, platforms: missing };
  if (!force && main === released) return null;
  return { sha: main, platforms };
}

/** Each sibling must be clean at the remote's current default branch, including detached CI checkouts. */
export function assertReleaseSiblings(root = ROOT): void {
  for (const name of ['solidjs-toolkit', 'CLIProxyAPI']) {
    const dir = path.join(root, '..', name);
    git(['fetch', 'origin'], dir);
    git(['remote', 'set-head', 'origin', '--auto'], dir);
    if (git(['status', '--porcelain', '--untracked-files=no'], dir) || git(['rev-parse', 'HEAD'], dir) !== git(['rev-parse', 'origin/HEAD'], dir)) {
      throw new Error(`${dir} is not clean at its latest pushed default-branch commit; rebuild from it, then release.`);
    }
  }
}
