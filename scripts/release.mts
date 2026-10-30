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
  signatureContext: UPDATE_SIGNATURE_CONTEXT,
  dist: path.join(ROOT, 'dist'),
  publicKeyFile: path.join(ROOT, 'resources', 'update-public-key.pem'),
  keyFile: process.env.SPILLWAY_UPDATE_KEY || path.join(os.homedir(), '.config', 'spillway', 'update_key'),
  version: () => appVersion(ROOT),
  archs: { win32: ['x64'], darwin: MAC_ARCHS },
  // electron-builder.ts artifact names.
  updateFile: (platform, arch, v) => (platform === 'win32' ? `${APP_NAME}-Setup-${v}.exe` : `${APP_NAME}-${v}-${arch}-mac.zip`),
  // Disk images: the first install on a Mac.
  extraFiles: (platform, v) => (platform === 'darwin' ? MAC_ARCHS.map((arch) => `${APP_NAME}-${v}-${arch}.dmg`) : []),
});
