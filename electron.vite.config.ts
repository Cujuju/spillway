import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import solid from 'vite-plugin-solid';
import { appVersion, gitBuild } from './appVersion.ts';

/** Created by `node scripts/release.mts keygen`; without it the build cannot verify, so it never updates. */
const UPDATE_PUBLIC_KEY_FILE = resolve('resources/update-public-key.pem');
const updatePublicKey = existsSync(UPDATE_PUBLIC_KEY_FILE) ? readFileSync(UPDATE_PUBLIC_KEY_FILE, 'utf8').trim() : '';
/** Read once when the build or dev server starts. */
const version = appVersion(import.meta.dirname);
const build = gitBuild(import.meta.dirname);

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    define: { __UPDATE_PUBLIC_KEY__: JSON.stringify(updatePublicKey), __APP_VERSION__: JSON.stringify(version), __APP_BUILD__: JSON.stringify(build) },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } },
  },
  renderer: {
    plugins: [solid()],
    resolve: { alias: { '@shared': resolve('src/shared'), '@': resolve('src/renderer/src') } },
  },
});
