import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import license from 'rollup-plugin-license';
import solid from 'vite-plugin-solid';
import { appVersion, gitBuild } from './appVersion.ts';

/** Created by `node scripts/release.mts keygen`; without it the build cannot verify, so it never updates. */
const UPDATE_PUBLIC_KEY_FILE = resolve('resources/update-public-key.pem');
const updatePublicKey = existsSync(UPDATE_PUBLIC_KEY_FILE) ? readFileSync(UPDATE_PUBLIC_KEY_FILE, 'utf8').trim() : '';
/** Read once when the build or dev server starts. */
const version = appVersion(import.meta.dirname);
const build = gitBuild(import.meta.dirname);
/** The @cujuju/solidjs-* packages are linked from a sibling checkout (package.json `link:`). */
const TOOLKIT_DIR = resolve('../solidjs-toolkit');
/** Licenses whose notice file covers redistribution; anything else, or a package with no license, fails the build. */
const SHIPPABLE_LICENSES = '(MIT OR ISC OR 0BSD OR BSD-2-Clause OR BSD-3-Clause OR Apache-2.0)';

/** Writes the license text of every npm package bundled into `bundle` to out/licenses/, which electron-builder.ts ships. */
const bundledLicenses = (bundle: 'main' | 'preload' | 'renderer') =>
  license({
    thirdParty: {
      allow: { test: SHIPPABLE_LICENSES, failOnUnlicensed: true, failOnViolation: true },
      output: { file: resolve(`out/licenses/npm-${bundle}.txt`) },
    },
  });

// The dev build (src/shared/app.ts): `pnpm dev`, and the build `pnpm data:merge` runs for it.
export default defineConfig(({ command }) => {
  const devBuild = command === 'serve' || process.env.SPILLWAY_DEV_BUILD === '1';
  const devDefine = { __DEV_BUILD__: JSON.stringify(devBuild) };
  return {
    main: {
      // Bundled: a linked package isn't in the packaged app's node_modules.
      plugins: [externalizeDepsPlugin({ exclude: ['@cujuju/electron-updates'] }), bundledLicenses('main')],
      resolve: { alias: { '@shared': resolve('src/shared') } },
      define: {
        ...devDefine,
        // No key, no updates: the production feed would install production, not update the dev build.
        __UPDATE_PUBLIC_KEY__: JSON.stringify(devBuild ? '' : updatePublicKey),
        __APP_VERSION__: JSON.stringify(version),
        __APP_BUILD__: JSON.stringify(build),
      },
    },
    preload: {
      plugins: [externalizeDepsPlugin(), bundledLicenses('preload')],
      resolve: { alias: { '@shared': resolve('src/shared') } },
      define: devDefine,
      build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } },
    },
    renderer: {
      plugins: [solid(), bundledLicenses('renderer')],
      define: devDefine,
      resolve: {
        alias: { '@shared': resolve('src/shared'), '@': resolve('src/renderer/src') },
        // Linked toolkit packages sit outside this tree; one Solid runtime, or their signals never update ours.
        dedupe: ['solid-js'],
      },
      server: { fs: { allow: ['.', TOOLKIT_DIR] } },
    },
  };
});
