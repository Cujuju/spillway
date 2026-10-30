import { existsSync } from 'node:fs';
import path from 'node:path';
import { Arch, type Configuration } from 'electron-builder';
import { appVersion } from './appVersion.ts';

const config: Configuration = {
  appId: 'dev.cujuju.spillway',
  productName: 'Spillway',
  // package.json carries no version; the packaged app, installer and update listings take appVersion.ts's.
  extraMetadata: { version: appVersion(import.meta.dirname) },
  directories: { output: 'dist', buildResources: 'resources' },
  files: ['out/**', 'package.json'],
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
    { from: 'src/renderer/src/assets/providers/LICENSE', to: 'licenses/LobeHub-Icons.txt' },
  ],
  // electron-builder only warns on a missing extraResources source; the proxy must not ship without its notice.
  beforePack: (context) => {
    const license = path.join(import.meta.dirname, 'resources', 'bin', `${context.electronPlatformName}-${Arch[context.arch]}`, 'LICENSE');
    if (!existsSync(license)) throw new Error(`${license} is missing. Run pnpm proxy:build for this target.`);
  },
  // No publish feed: scripts/release.mts signs the update files and uploads them (src/shared/updateFeed.ts).
  win: {
    target: [{ target: 'nsis', arch: 'x64' }],
    icon: 'resources/icon.ico',
  },
  nsis: {
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
    // The disk image is the first install; the zip is what the updater downloads (@cujuju/electron-updates).
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ],
    // The arch in every name: the updater picks its own build by it.
    artifactName: '${productName}-${version}-${arch}-mac.${ext}',
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
