/**
 * Stable or nightly updates from UPDATE_REPO (@cujuju/electron-updates), verified with the built-in Ed25519 key.
 * Same path on every OS; nothing downloads or installs until the user chooses.
 */
import { app, net } from 'electron';
import { createUpdater } from '@cujuju/electron-updates';
import { APP_NAME } from '@shared/app';
import { UPDATE_REPO, UPDATE_SIGNATURE_CONTEXT } from '@shared/updateFeed';
import { appPaths } from './paths';
import { getSettings } from './settingsStore';

export const updates = createUpdater({
  app,
  appName: APP_NAME,
  repo: UPDATE_REPO,
  publicKey: __UPDATE_PUBLIC_KEY__,
  signatureContext: UPDATE_SIGNATURE_CONTEXT,
  channel: () => getSettings().updates.channel,
  dir: appPaths.updatesDir,
  fetch: (url, init) => net.fetch(url, init),
});
