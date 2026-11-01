// Erasable TypeScript only: electron-builder.ts and scripts/release.mts import this under plain Node.

/** Set by electron.vite.config.ts; undefined under plain Node and in tests, which are the production identity. */
declare const __DEV_BUILD__: boolean | undefined;

/**
 * Production, or the dev build run from the repo (`pnpm dev`, `pnpm dev:shortcut`).
 * Its own id and name give it its own data folder, single-instance lock and Windows app ID.
 */
export function appIdentity(dev: boolean): { id: string; name: string } {
  return dev ? { id: 'dev.cujuju.spillway.dev', name: 'Spillway Dev' } : { id: 'dev.cujuju.spillway', name: 'Spillway' };
}

export const IS_DEV_BUILD = typeof __DEV_BUILD__ !== 'undefined' && __DEV_BUILD__;

/** Product name shown in UI, menus and written config comments; production's matches package.json productName. */
export const { id: APP_ID, name: APP_NAME } = appIdentity(IS_DEV_BUILD);
/** Spillway's GitHub repository. */
export const REPO_URL = 'https://github.com/Cujuju/spillway';
