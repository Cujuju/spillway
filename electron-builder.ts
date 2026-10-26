import type { Configuration } from 'electron-builder';
import { appVersion } from './appVersion.ts';

const config: Configuration = {
  appId: 'dev.cujuju.spillway',
  productName: 'Spillway',
  // package.json carries no version; the packaged app, installer and update listings take appVersion.ts's.
  extraMetadata: { version: appVersion(import.meta.dirname) },
  directories: { output: 'dist', buildResources: 'resources' },
  files: ['out/**', 'package.json'],
  extraResources: [
    // Proxy binary for the platform and arch being packaged, built by `pnpm proxy:build`.
    // Folder names match scripts/build-proxy.mjs and src/main/paths.ts.
    { from: 'resources/bin/${platform}-${arch}', to: 'bin' },
    // Tray, window and notification icon; main reads it from process.resourcesPath.
    { from: 'resources/icon.png', to: 'icon.png' },
  ],
  // Update feed. Builds write app-update.yml and latest*.yml from it but never publish (package runs
  // with --publish never); scripts/release.mts signs the files and uploads them.
  publish: { provider: 'github', owner: 'Cujuju', repo: 'spillway-updates', releaseType: 'release' },
  win: {
    target: [{ target: 'nsis', arch: 'x64' }],
    icon: 'resources/icon.ico',
  },
  nsis: {
    // No spaces: GitHub renames spaced uploads, and latest.yml's url must match the uploaded name.
    artifactName: '${productName}-Setup-${version}.${ext}',
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    runAfterFinish: true,
  },
  // macOS builds must run on a Mac (dmg and code signing need macOS tools).
  mac: {
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }],
    icon: 'resources/icon-1024.png',
    category: 'public.app-category.developer-tools',
    darkModeSupport: true,
    // Ad-hoc signature: Apple Silicon refuses unsigned apps, and no Developer ID is configured.
    // Runs when built on the Mac that uses it; a downloaded copy is blocked by Gatekeeper.
    // Hardened runtime would reject Electron's pre-signed frameworks under ad-hoc signing.
    // Developer ID build: pnpm package -c.mac.identity="Developer ID Application: …" -c.mac.hardenedRuntime=true
    identity: '-',
    hardenedRuntime: false,
  },
  dmg: { artifactName: '${productName}-${version}-${arch}.${ext}' },
};

export default config;
