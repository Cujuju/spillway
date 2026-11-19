import path from 'node:path';
import { app } from 'electron';

/** Why macOS sent the quit Apple Event: `quit` is the Dock's Quit (or a script's); the rest come from logout, restart or shutdown. */
export type QuitReason = 'quit' | 'logout' | 'restart' | 'shutdown' | 'system';

export interface QuitReasonAddon {
  install(): boolean;
  takeQuit(): { reason: QuitReason; ageMs: number } | null;
}

/** A quit event older than this didn't start the quit now under way (the app quit on its own after it). */
const EVENT_MAX_AGE_MS = 2_000;

let addon: QuitReasonAddon | null = null;

/** The universal addon scripts/build-native.mjs builds; electron-builder.ts ships it under Resources/native. */
function addonPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'native', 'quit-reason.node')
    : path.join(app.getAppPath(), 'resources', 'native', 'darwin', 'quit-reason.node');
}

/** macOS: starts recording quit Apple Events (call after ready). A missing addon logs once; Dock Quit then skips the confirmation. */
export function watchQuitEvents(load: (file: string) => QuitReasonAddon = loadAddon): void {
  if (process.platform !== 'darwin' || addon) return;
  try {
    const loaded = load(addonPath());
    if (loaded.install()) addon = loaded;
    else console.error('[quit] quit event handler not installed');
  } catch (err) {
    console.error('[quit] quit reason addon unavailable:', err);
  }
}

function loadAddon(file: string): QuitReasonAddon {
  const module = { exports: {} as QuitReasonAddon };
  process.dlopen(module, file);
  return module.exports;
}

/** The reason of the quit event that started this quit, consumed on read; null when the app or the OS quit some other way. */
export function takeQuitReason(): QuitReason | null {
  const event = addon?.takeQuit();
  return event && event.ageMs <= EVENT_MAX_AGE_MS ? event.reason : null;
}
