// Where updates are published and how they are signed; shared by the app and scripts/release.mts.
// Erasable TypeScript only: Node runs the release script directly.
import type { UpdateChannel } from '@cujuju/electron-updates';

export type { UpdateChannel };

/** Public repo holding only release files; the source repo is private. */
export const UPDATE_REPO = 'Cujuju/spillway-updates';

/** Binds signatures to Spillway, so a signature made for another app's files never verifies here. */
export const UPDATE_SIGNATURE_CONTEXT = 'spillway-update-v1';

/** Settings → Updates choices; the type is the updater's. */
export const UPDATE_CHANNELS = ['stable', 'nightly'] as const satisfies readonly UpdateChannel[];
