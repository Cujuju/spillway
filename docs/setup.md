[← Spillway](../README.md)

# Build and run

| Task | Command |
|---|---|
| Install deps | `pnpm install` |
| Build the proxy into `resources/bin/<platform>-<arch>` | `pnpm proxy:build` for this machine, or `pnpm proxy:build darwin-arm64 darwin-x64`, or `all` (source: `CLIPROXY_SRC` or `../CLIProxyAPI`) |
| Dev, with hot reload | `pnpm dev` (rebuilds the proxy first; if that fails, it keeps the last good binary and logs why) |
| Installer | `pnpm package` → Windows: `dist/Spillway-Setup-<ver>.exe` (per-user install with Start Menu and desktop shortcuts); macOS: `dist/Spillway-<ver>-<arch>.dmg` |
| Dev build, installed beside production | `pnpm package:dev` → `dist-dev/`; on Windows it also runs the one-click installer, which adds or updates **Spillway Dev** in the Start Menu (`--no-install` skips that) |
| Checks | `pnpm typecheck`, `pnpm test` |

CI (`.github/workflows/build.yml`) builds the Windows and macOS installers on each push to `main` and uploads them as artifacts. It checks out the private fork with the repository secret `CLIPROXY_SRC_TOKEN` (a fine-grained token with read access to `Cujuju/CLIProxyAPI` contents); Go comes from the fork's `go.mod`, Node from `engines.node`, pnpm from `packageManager`.

Spillway Dev (`pnpm package:dev` and `pnpm dev`) has its own app id, name and data folder (`%APPDATA%\Spillway Dev`, `~/Library/Application Support/Spillway Dev`), so it never replaces the production install, and it never updates itself. It uses the same default proxy port, so run one copy at a time.

When production Spillway is installed, Spillway Dev's proxy uses production's client key, management key and accounts, read from production's `proxy/config.yaml`. Claude Code, Codex and T3 Code's usage hub then keep working whichever copy runs, with nothing to re-apply. Regenerate the client key in production. Without production, Spillway Dev uses its own keys and starts with no accounts.

`pnpm dev` breaks if the environment has `ELECTRON_RUN_AS_NODE` set: Electron then runs as plain Node. Unset it first.

Launch at login only applies to installed builds.

## Demo and screenshots

`pnpm demo` opens the built app on fake data: a throwaway profile and home folder, and a fake proxy (`scripts/demo/`) that serves generated accounts, 2 weeks of usage history and 4 weeks of requests. Nothing from your own profile, logins or client logs loads. The data is seeded, so every run draws the same numbers relative to the current time.

`pnpm screenshots` captures the Dashboard, Activity and Providers pages from that demo in a dark and a light theme into `docs/images/`. `pnpm release promote` runs it and commits changed images. 5-hour windows follow the local clock, so run it during the day to show live ones.

The app's `--proxy-endpoint=<url>` switch makes it use a proxy already running at that address instead of starting the bundled one; the demo uses it.

## macOS

Build on a Mac (electron-builder can't make macOS apps on Windows): `pnpm install`, `pnpm proxy:build darwin-arm64 darwin-x64`, `pnpm package`.

- The app is ad-hoc signed, which Apple Silicon needs to launch it. A build made on your Mac runs as is; a copy downloaded from elsewhere is blocked by Gatekeeper. Distributing it needs a Developer ID and notarization (see `electron-builder.yml`).
- The window uses the native traffic lights. While the window is hidden in the menu bar, the app leaves the Dock.
- "Start minimized" applies to login launches via `wasOpenedAtLogin`. macOS may ask you to approve the login item in System Settings → General → Login Items.
- Keys are encrypted with the macOS Keychain; the first launch may ask for access.
- Data lives in `~/Library/Application Support/Spillway`.
