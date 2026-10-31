/**
 * Signs and publishes updates from this machine (README → Updates):
 *   pnpm release keygen | nightly [--dry-run] | promote <version> [--dry-run]
 * The private key stays outside the repo: $SPILLWAY_UPDATE_KEY or ~/.config/spillway/update_key.
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runReleaseCli } from '@cujuju/electron-updates/node';
import { appVersion } from '../appVersion.ts';
import { APP_NAME } from '../src/shared/app.ts';
import { UPDATE_REPO, UPDATE_SIGNATURE_CONTEXT } from '../src/shared/updateFeed.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The macOS architectures electron-builder.ts packages. */
const MAC_ARCHS = ['arm64', 'x64'];

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
