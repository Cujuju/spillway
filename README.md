# Spillway

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
- Checks for updates and installs them after verifying their signature (macOS: downloads the disk image).
- Ten colour themes (Midnight, Tonal, OLED Black, Nord, Dracula, Catppuccin Mocha and Latte, Solarized Dark and Light, Light), or follow the system light/dark mode.
- "Show emails" off masks every account email in the window, tray tooltips and notifications.

Provider logos come from [lobe-icons](https://github.com/lobehub/lobe-icons) (MIT); see `src/renderer/src/assets/providers/`.

## Security and terms

Read this before you use Spillway.

### Provider terms

Spillway lets you use several of your own subscription accounts without signing out and in. It does that by running their logins through a local proxy rather than the providers' own apps.

- Using a subscription login outside the provider's apps, or pooling several accounts, may break a provider's terms. Providers can limit or close accounts for it. Read each provider's current terms; Spillway doesn't check them.
- When an account runs out, routing sends requests to another account. A provider may treat that as getting around its usage limits, whatever the intent.
- The proxy disguises requests by default (upstream settings): Claude-account requests from clients other than Claude Code are made to look like Claude Code, system prompt included (`disable-claude-cloak-mode: false`), and Codex-account requests get Codex's User-Agent and Originator headers (`disable-codex-cloaking: false`).

### What each secret unlocks

| Secret | Stored in | Anyone holding it can |
|---|---|---|
| Account logins (OAuth tokens) | `proxy/auths/*.json`, unencrypted | act as that account at the provider until the login is revoked |
| Management key | `secrets.bin` (encrypted); the proxy keeps only a hash | read every account login (auth-file download, `api-call` with any account's token) and change the proxy's config, from this machine only |
| Supervisor password | the proxy's environment, new each launch, never on disk | the same as the management key |
| Client key | `secrets.bin`, and in plain text in `~/.claude/settings.json`, `~/.codex/auth.json` (the pool login) and anywhere you paste it | spend every pooled account's quota, and use the routed Codex account's Codex features: usage, plan, reset credits, cloud tasks, environments, plugins, file uploads |

The client key can't reach the rest of a ChatGPT account. The proxy forwards only the account calls Codex makes (listed in the fork's `docs/desktop-api.md`) and refuses conversations, memories, account settings and file downloads.

### Exposure

- **Network.** The proxy listens on 127.0.0.1. **Allow LAN connections** makes it listen on every interface over plain HTTP: the client key crosses the network unencrypted, and anyone who has it can use the pool. Management stays local-only either way.
- **This machine.** Any program running as you can read the account logins and the client key. Spillway doesn't defend against malware on your machine.
- **Codex account calls.** They act as whichever Codex account routing picks, so cloud tasks and plugins can land on different accounts, and the client key reaches that account's Codex data. Pool only your own accounts.
- **Outside tools.** T3 Code's usage hub gets the management key, so it can read every account login.
- **Logs.** Failed requests are logged with their full request body (prompts and code) in `proxy/auths/logs/`. The Activity page's history stores only metadata (account, model, status, tokens, timing).
- **Custom proxy executable.** It runs with every account login. Point it only at a build you trust.

## Run

| Task | Command |
|---|---|
| Install deps | `pnpm install` |
| Build the proxy into `resources/bin/<platform>-<arch>` | `pnpm proxy:build` for this machine, or `pnpm proxy:build darwin-arm64 darwin-x64`, or `all` (source: `CLIPROXY_SRC` or `../CLIProxyAPI`) |
| Dev, with hot reload | `pnpm dev` (rebuilds the proxy first; if that fails, it keeps the last good binary and logs why) |
| Installer | `pnpm package` → Windows: `dist/Spillway-Setup-<ver>.exe` (per-user install with Start Menu and desktop shortcuts); macOS: `dist/Spillway-<ver>-<arch>.dmg` |
| Checks | `pnpm typecheck`, `pnpm test` |

CI (`.github/workflows/build.yml`) builds the Windows and macOS installers on each push to `main` and uploads them as artifacts. It checks out the private fork with the repository secret `CLIPROXY_SRC_TOKEN` (a fine-grained token with read access to `Cujuju/CLIProxyAPI` contents); Go comes from the fork's `go.mod`, Node from `engines.node`, pnpm from `packageManager`.

`pnpm dev` breaks if the environment has `ELECTRON_RUN_AS_NODE` set: Electron then runs as plain Node. Unset it first.

Launch at login only applies to installed builds.

## macOS

Build on a Mac (electron-builder can't make macOS apps on Windows): `pnpm install`, `pnpm proxy:build darwin-arm64 darwin-x64`, `pnpm package`.

- The app is ad-hoc signed, which Apple Silicon needs to launch it. A build made on your Mac runs as is; a copy downloaded from elsewhere is blocked by Gatekeeper. Distributing it needs a Developer ID and notarization (see `electron-builder.yml`).
- The window uses the native traffic lights. While the window is hidden in the menu bar, the app leaves the Dock.
- "Start minimized" applies to login launches via `wasOpenedAtLogin`. macOS may ask you to approve the login item in System Settings → General → Login Items.
- Keys are encrypted with the macOS Keychain; the first launch may ask for access.
- Data lives in `~/Library/Application Support/Spillway`.

## Connect clients

The Proxy page shows the endpoint and the client key. **Apply** writes them into a client's own config; **Undo** reverses it.

| Client | File | Apply sets |
|---|---|---|
| Claude Code | `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR`) | `env.ANTHROPIC_BASE_URL` and `env.ANTHROPIC_CUSTOM_HEADERS` (`X-Api-Key: <client key>`), and removes `env.ANTHROPIC_AUTH_TOKEN` |
| Codex | `~/.codex/config.toml` (or `$CODEX_HOME`) | root `openai_base_url = "<endpoint>/backend-api/codex"`, `chatgpt_base_url = "<endpoint>/backend-api/"` and `cli_auth_credentials_store = "file"` at the top |
| Codex login | `auth.json` beside `config.toml` | the pool login (see below) |

- The first Apply copies the file to `<file>.spillway-backup` (an empty backup when the file did not exist). Undo removes the backup.
- Claude Code: the key goes in a header so Claude Code keeps its subscription login (it must stay signed in; requests still use the proxy's accounts). In token mode it ignores usage-limit headers, so T3 Code can't snooze a thread until the reset. Apply keeps other `ANTHROPIC_CUSTOM_HEADERS` lines. Undo puts back only these variables' earlier values (or removes them); other edits made since stay.
- Codex: the app's lines sit between `# >>> spillway` and `# <<< spillway` markers. Existing root `model_provider`, `openai_base_url`, `chatgpt_base_url` or `cli_auth_credentials_store` lines are commented out with `# spillway disabled: `; Undo removes the markers' blocks and restores those lines. Codex keeps its built-in OpenAI provider, pointed at the proxy: a custom provider loses the tools Codex offers only on that provider, such as image generation. A `model_provider` line would switch provider, so Apply turns it off. Apply replaces an older apply's `[model_providers.spillway]` block.
- Codex login: Codex authenticates every proxy call with its `auth.json` token: model, image and search calls under `openai_base_url`, account calls (plan usage, rate-limit resets, plugins) under `chatgpt_base_url`. The proxy answers account calls as the pooled Codex account that requests route to, or the one that resets first when all are spent. Codex therefore needs no ChatGPT login of its own, and T3 Code's usage and snooze show the pool. Apply backs up your `auth.json` and writes a pool login whose token, derived from the client key, the proxy accepts. Undo restores your login unless you signed in again since. The pool login grants access to the proxy, like the client key.
- Codex apps (ChatGPT connectors) don't work through the proxy: Codex sends its token to the apps server only on chatgpt.com, so the proxy answers those calls `401`. See [#24](https://github.com/Cujuju/spillway/issues/24).
- A Codex process started before Apply or Undo keeps its old URLs but reloads `auth.json`, so it sends one side's login to the other and its calls fail. After either, the page names the apps running Codex (a dev Electron app by its project folder); restart them (in T3 Code, start a new Codex session).
- Changing the port or regenerating the key marks an applied client **Out of date**; Re-apply updates it. The app never rewrites these files on its own.
- Codex edits are text-level, not parsed TOML: a multi-line string containing a line that starts with `[` or one of those root keys can be misread.

Or set environment variables for Claude Code (the page copies them):

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:8317"
Remove-Item Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue
$env:ANTHROPIC_CUSTOM_HEADERS = "X-Api-Key: <client key from the Proxy page>"
```

## Updates

Settings → Updates checks the public [Cujuju/spillway-updates](https://github.com/Cujuju/spillway-updates) repo (`publish` in `electron-builder.yml`), which holds only release files. With **Check automatically** on, the app checks a minute after launch and every 6 hours and shows a notification; nothing downloads or installs until you click.

- Each installer listed in `latest.yml` / `latest-mac.yml` carries an Ed25519 signature over the app, version, file name and SHA-512. The app checks the downloaded file against the public key built into it (`resources/update-public-key.pem`) and deletes a file that fails.
- Windows: **Download**, then **Restart and install**: the app stops the proxy and runs the installer, which reopens the app.
- macOS: Squirrel.Mac only installs Developer ID-signed apps, so with ad-hoc signing the app downloads the verified disk image to Downloads; open it and drag the app to Applications.
- A build made without `resources/update-public-key.pem` cannot verify updates and never offers one.
- The listing itself is not signed. Someone with write access to the updates repo can withhold updates, or list an old signed installer under its own older version, which the app ignores; they cannot get an unsigned or relabelled file installed.

### Signing key (once)

```sh
node scripts/release.mts keygen
```

Writes the private key to `~/.config/spillway/update_key` (or `$SPILLWAY_UPDATE_KEY`) and the public key to `resources/update-public-key.pem`. Commit the public key so every build embeds it. Back up the private key outside the repo: installed copies accept updates only from it. On Windows the file is protected by your user profile's permissions.

### Release

1. Bump `version` in `package.json` and commit.
2. Build the installers: `pnpm package` on each platform, or download the CI artifacts into one folder.
3. `pnpm release sign [dist]` adds the signatures to `latest.yml` / `latest-mac.yml`.
4. `pnpm release publish [dist] --dry-run` shows the `gh` commands; run it without `--dry-run` to create the `v<version>` release, or add the other platform's files to it. Needs `gh` with push access to the updates repo.

Publish both platforms' files: until the newest release has `latest-mac.yml`, Mac checks report an error (and Windows ones until it has `latest.yml`).

## Data

Everything lives in `%APPDATA%\Spillway` (macOS: `~/Library/Application Support/Spillway`):

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

The app manages the proxy with a random password created per launch and passed in `MANAGEMENT_SUPERVISOR_PASSWORD`. A custom proxy executable must support it.

Outside tools use a separate, stable management key from `secrets.bin` (the proxy stores it hashed). T3 Code shows every pooled account's quota with it: Settings → Providers → Usage providers → Add a CLIProxyAPI hub, with the Hub URL and Management key from the Proxy page's T3 Code steps. Use the management key there, not the client key (that gets `401`). Wrong keys from other tools lock 127.0.0.1 out of management: 5 minutes after 5 failures, then 30 minutes after 3 more. The Proxy page's **Management lockouts** row shows them and resets them; the app itself is never locked out.
