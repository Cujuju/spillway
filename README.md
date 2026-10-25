# CLIProxy Desktop

Windows and macOS tray (menu bar) app that runs the private CLIProxyAPI fork, signs in subscription accounts, and shows their limits.

- Runs and supervises the bundled `cli-proxy-api` binary: starts it with the app, restarts it after a crash, and shuts it down cleanly on quit.
- Routes with the **soonest-reset** strategy and session affinity by default.
- Dashboard shows pool remaining, drain rate, a forecast chart, and per-account 5-hour and weekly bars.
- Accounts page signs in accounts through the browser (OAuth). You can rename, prioritise, disable or remove each one.
- Activity page lists each upstream request live (account, model, result, tokens, time to first token), with a failed-only filter. Usage refreshes as requests finish.
- Proxy page applies the endpoint and client key to Claude Code's and Codex's own config files, with a backup and Undo.
- Tray "Use account" menu pins a provider to one account while it is available; Automatic returns to the routing strategy.
- Optional tray icons, one per limit: active account, pool average, least left, or one specific account.
- Launches at login, starts minimised, and closes or minimises to the tray.
- Ten colour themes (Midnight, Tonal, OLED Black, Nord, Dracula, Catppuccin Mocha and Latte, Solarized Dark and Light, Light), or follow the system light/dark mode.
- "Show emails" off masks every account email in the window, tray tooltips and notifications.

Provider logos come from [lobe-icons](https://github.com/lobehub/lobe-icons) (MIT); see `src/renderer/src/assets/providers/`.

## Run

| Task | Command |
|---|---|
| Install deps | `pnpm install` |
| Build the proxy into `resources/bin/<platform>-<arch>` | `pnpm proxy:build` for this machine, or `pnpm proxy:build darwin-arm64 darwin-x64`, or `all` (source: `CLIPROXY_SRC` or `../CLIProxyAPI`) |
| Dev, with hot reload | `pnpm dev` |
| Installer | `pnpm package` → Windows: `dist/CLIProxy Desktop Setup <ver>.exe`; macOS: `dist/CLIProxy Desktop-<ver>-<arch>.dmg` |
| Checks | `pnpm typecheck`, `pnpm test` |

`pnpm dev` breaks if the environment has `ELECTRON_RUN_AS_NODE` set: Electron then runs as plain Node. Unset it first.

Launch at login only applies to installed builds.

## macOS

Build on a Mac (electron-builder can't make macOS apps on Windows): `pnpm install`, `pnpm proxy:build darwin-arm64 darwin-x64`, `pnpm package`.

- The app is ad-hoc signed, which Apple Silicon needs to launch it. A build made on your Mac runs as is; a copy downloaded from elsewhere is blocked by Gatekeeper. Distributing it needs a Developer ID and notarization (see `electron-builder.yml`).
- The window uses the native traffic lights. While the window is hidden in the menu bar, the app leaves the Dock.
- "Start minimized" applies to login launches via `wasOpenedAtLogin`. macOS may ask you to approve the login item in System Settings → General → Login Items.
- Keys are encrypted with the macOS Keychain; the first launch may ask for access.
- Data lives in `~/Library/Application Support/CLIProxy Desktop`.

## Connect clients

The Proxy page shows the endpoint and the client key. **Apply** writes them into a client's own config; **Undo** reverses it.

| Client | File | Apply sets |
|---|---|---|
| Claude Code | `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR`) | `env.ANTHROPIC_BASE_URL` and `env.ANTHROPIC_AUTH_TOKEN` |
| Codex | `~/.codex/config.toml` (or `$CODEX_HOME`) | a `[model_providers.cliproxy]` block at the end (`base_url = "<endpoint>/v1"`, `wire_api = "responses"`, `experimental_bearer_token`), and a root `model_provider = "cliproxy"` at the top |

- The first Apply copies the file to `<file>.cliproxy-backup` (an empty backup when the file did not exist). Undo removes the backup.
- Claude Code: Undo puts back only the two variables' earlier values (or removes them); other edits made since stay.
- Codex: the app's lines sit between `# >>> cliproxy-desktop` and `# <<< cliproxy-desktop` markers. An existing root `model_provider` line is commented out with `# cliproxy-desktop disabled: `; Undo removes the markers' blocks and restores that line. Apply refuses when the file already defines `model_providers.cliproxy` itself. Codex stores the key in plain text there.
- Changing the port or regenerating the key marks an applied client **Out of date**; Re-apply updates it. The app never rewrites these files on its own.
- Codex edits are text-level, not parsed TOML: a multi-line string containing a line that starts with `[` or `model_provider =` can be misread.

Or set environment variables for Claude Code (the page copies them):

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:8317"
$env:ANTHROPIC_AUTH_TOKEN = "<client key from the Proxy page>"
```

## Data

Everything lives in `%APPDATA%\CLIProxy Desktop` (macOS: `~/Library/Application Support/CLIProxy Desktop`):

| Item | Path |
|---|---|
| Settings | `settings.json` |
| Keys | `secrets.bin`, encrypted with DPAPI (Windows) or the Keychain (macOS) |
| Usage history | `usage-history.json` |
| Generated proxy config | `proxy/config.yaml` |
| Your proxy settings | `proxy/config.user.yaml` |
| Account logins | `proxy/auths/` |
| Logs | `proxy/proxy.log` (previous run: `proxy.prev.log`) |

`config.yaml` is generated from the app settings and `config.user.yaml`; don't edit it. Put custom proxy keys (v8 layout) in `config.user.yaml` (Proxy page → Edit config.user.yaml). Saving it applies live; keys the app owns (server, management, routing strategy and affinity, auth dir, first-byte timeout) are replaced by the app's values.

The app manages the proxy with a random password created per launch and passed in `MANAGEMENT_SUPERVISOR_PASSWORD`; no management key is stored. A custom proxy executable must support it.
