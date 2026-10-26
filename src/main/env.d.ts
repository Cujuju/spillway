/** Ed25519 public key (SPKI PEM) that update files must be signed with; empty when the build has none. Set by electron.vite.config.ts. */
declare const __UPDATE_PUBLIC_KEY__: string;
/** Spillway's version (appVersion.ts), from git history. Set by electron.vite.config.ts. */
declare const __APP_VERSION__: string;

declare namespace Electron {
  interface App {
    /** Internal: Electron's dev loader sets the version from package.json this way. */
    setVersion(version: string): void;
  }
}
