import { existsSync } from 'node:fs';
import path from 'node:path';
import { Arch, type Configuration } from 'electron-builder';
import { appVersion } from './appVersion.ts';
import { appIdentity } from './src/shared/app.ts';

/** Set by scripts/package-dev.mjs: the dev build, installed beside production under its own id and name. */
const devBuild = process.env.SPILLWAY_DEV_BUILD === '1';
const identity = appIdentity(devBuild);

const config: Configuration = {
  appId: identity.id,
  productName: identity.name,
  // package.json carries no version; the packaged app, installer and update listings take appVersion.ts's.
  // The dev build also renames the packaged package.json, which names the app and its data folder.
  extraMetadata: { version: appVersion(import.meta.dirname), ...(devBuild && { name: 'spillway-dev', productName: identity.name }) },
  // Separate output, so a dev build never overwrites production installers.
  directories: { output: devBuild ? 'dist-dev' : 'dist', buildResources: 'resources' },
  // out/licenses ships beside the app as plain files (extraResources), not inside app.asar.
  files: ['out/**', '!out/licenses/**', 'package.json'],
  extraResources: [
    // Proxy binary for this platform and arch, built by `pnpm proxy:build`.
    // Folders match scripts/build-proxy.mjs and src/main/paths.ts.
    // Only the binary: backup copies left beside it during proxy swaps must not ship.
    { from: 'resources/bin/${platform}-${arch}', to: 'bin', filter: ['cli-proxy-api', 'cli-proxy-api.exe'] },
    // Notification and macOS tray icon (.png); Windows window and tray icon (.ico). Main reads them from process.resourcesPath.
    { from: 'resources/icon.png', to: 'icon.png' },
    { from: 'resources/icon.ico', to: 'icon.ico' },
    // License notices for Spillway and the third-party work it ships. The proxy's comes from its fork (scripts/build-proxy.mjs).
    { from: 'LICENSE', to: 'licenses/Spillway.txt' },
    { from: 'resources/bin/${platform}-${arch}/LICENSE', to: 'licenses/CLIProxyAPI.txt' },
    // The proxy's compiled-in Go modules (scripts/build-proxy.mjs) and the npm packages bundled into the app (electron.vite.config.ts).
    { from: 'resources/bin/${platform}-${arch}/licenses', to: 'licenses/CLIProxyAPI-dependencies' },
    { from: 'out/licenses', to: 'licenses', filter: ['npm-*.txt'] },
    { from: 'src/renderer/src/assets/providers/LICENSE', to: 'licenses/LobeHub-Icons.txt' },
  ],
  // electron-builder only warns on a missing extraResources source; nothing ships without its license notices.
  beforePack: (context) => {
    const proxyDir = path.join(import.meta.dirname, 'resources', 'bin', `${context.electronPlatformName}-${Arch[context.arch]}`);
    const npmDir = path.join(import.meta.dirname, 'out', 'licenses');
    const required = [
      { file: path.join(proxyDir, 'LICENSE'), fix: 'pnpm proxy:build for this target' },
      { file: path.join(proxyDir, 'licenses'), fix: 'pnpm proxy:build for this target' },
      ...['main', 'preload', 'renderer'].map((b) => ({ file: path.join(npmDir, `npm-${b}.txt`), fix: 'pnpm build' })),
    ];
    for (const { file, fix } of required) if (!existsSync(file)) throw new Error(`${file} is missing. Run ${fix}.`);
  },
  // No publish feed: scripts/release.mts signs the update files and uploads them (src/shared/updateFeed.ts).
  win: {
    target: [{ target: 'nsis', arch: 'x64' }],
    icon: 'resources/icon.ico',
  },
  nsis: devBuild
    ? // Reinstalled after every build: one click, no wizard.
      { artifactName: 'Spillway-Dev-Setup-${version}.${ext}', oneClick: true, perMachine: false, createDesktopShortcut: false, runAfterFinish: true }
    : {
        // No spaces: GitHub renames spaced uploads, and the update manifest names the file as built.
        artifactName: '${productName}-Setup-${version}.${ext}',
        oneClick: false,
        perMachine: false,
        allowToChangeInstallationDirectory: true,
        createDesktopShortcut: true,
        runAfterFinish: true,
      },
  // macOS builds must run on a Mac (dmg and code signing need macOS tools).
  mac: {
    // Disk images serve first installs; updates rebuild the unpacked app bundle.
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
    ],
    icon: 'resources/icon-1024.png',
    category: 'public.app-category.developer-tools',
    darkModeSupport: true,
    // Ad-hoc signature: Apple Silicon refuses unsigned apps; no Developer ID set. Works on the building
    // Mac; downloaded copies hit Gatekeeper. Hardened runtime rejects Electron's frameworks under ad-hoc signing.
    identity: '-',
    // Developer ID build: pnpm package -c.mac.identity="Developer ID Application: …" -c.mac.hardenedRuntime=true
    hardenedRuntime: false,
  },
  dmg: { artifactName: '${productName}-${version}-${arch}.${ext}' },
};

export default config;
