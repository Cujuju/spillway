# Spillway

Windows and macOS tray (menu bar) app that runs the private CLIProxyAPI fork, signs in subscription accounts, and shows their limits.

- Runs and supervises the bundled `cli-proxy-api` binary: starts it with the app, restarts it after a crash, and shuts it down cleanly on quit.
- Routes with the **soonest-reset** strategy and session affinity by default.
- Dashboard shows pool remaining, drain rate, a forecast chart, and per-account 5-hour and weekly bars.
- Accounts page signs in accounts through the browser (OAuth). You can rename, prioritise, disable or remove each one.
- Activity page lists each upstream request live (account, model, result, tokens, time to first token), with a failed-only filter. Usage refreshes as requests finish.
- Client-log imports use native FSEvents on macOS: an initial scan, then changed files every 30 seconds and recovery scans when macOS reports dropped events or roots change. Healthy native watchers do no timed full sweep. If the optional native addon is unavailable, imports fall back to polling with a five-minute full sweep. Windows uses Node's watcher, which reports dropped events, so it also does no timed sweep.
- Proxy page applies the endpoint and client key to Claude Code's and Codex's own config files, with a backup and Undo.
- Tray "Use account" menu pins a provider to one account while it is available; Automatic returns to the routing strategy.
- Optional tray icons, one per limit: active account, pool average, least left, or one specific account.
- Launches at login, starts minimised, and closes or minimises to the tray.
- Stable or nightly updates, installed after verifying their signature, the same way on Windows and macOS.
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
| Client key | `secrets.bin`, and in plain text in `~/.claude/settings.json` and anywhere you paste it | spend every pooled account's quota |
| Codex's own ChatGPT login | `~/.codex/auth.json`, written by Codex | its usual ChatGPT access, and, while that account is in the pool, the client key's access too |

The client key can't reach a ChatGPT account's data. Codex's account calls (usage, plan, plugins, cloud tasks) go to chatgpt.com with Codex's own login; the proxy serves only model, image and search calls, plus Codex's model list.

### Exposure

- **Network.** The proxy listens on 127.0.0.1. **Allow LAN connections** makes it listen on every interface over plain HTTP: the client key crosses the network unencrypted, and anyone who has it can use the pool. Management stays local-only either way.
- **This machine.** Any program running as you can read the account logins and the client key. Spillway doesn't defend against malware on your machine.
- **Codex accounts.** Codex's model calls run on whichever pooled account routing picks, not necessarily the one Codex is signed in to. Pool only your own accounts.
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
| Dev build, installed beside production | `pnpm package:dev` → `dist-dev/`; on Windows it also runs the one-click installer, which adds or updates **Spillway Dev** in the Start Menu (`--no-install` skips that) |
| Checks | `pnpm typecheck`, `pnpm test` |

CI (`.github/workflows/build.yml`) builds the Windows and macOS installers on each push to `main` and uploads them as artifacts. It checks out the private fork with the repository secret `CLIPROXY_SRC_TOKEN` (a fine-grained token with read access to `Cujuju/CLIProxyAPI` contents); Go comes from the fork's `go.mod`, Node from `engines.node`, pnpm from `packageManager`.

Spillway Dev (`pnpm package:dev` and `pnpm dev`) has its own app id, name and data folder (`%APPDATA%\Spillway Dev`, `~/Library/Application Support/Spillway Dev`), so it never replaces or reads the production install. It starts with no accounts, and it never updates itself. It uses the same default proxy port, so run one copy at a time.

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
| Codex | `~/.codex/config.toml` (or `$CODEX_HOME`) | root `openai_base_url = "<endpoint>/backend-api/codex"` at the top |

- The first Apply copies the file to `<file>.spillway-backup` (an empty backup when the file did not exist). Undo removes the backup.
- Claude Code: the key goes in a header so Claude Code keeps its subscription login (it must stay signed in; requests still use the proxy's accounts). In token mode it ignores usage-limit headers, so T3 Code can't snooze a thread until the reset. Apply keeps other `ANTHROPIC_CUSTOM_HEADERS` lines. Undo puts back only these variables' earlier values (or removes them); other edits made since stay.
- Codex: the app's lines sit between `# >>> spillway` and `# <<< spillway` markers. Existing root `model_provider` or `openai_base_url` lines are commented out with `# spillway disabled: `; Undo removes the markers' blocks and restores those lines. Codex keeps its built-in OpenAI provider, pointed at the proxy: a custom provider loses the tools Codex offers only on that provider, such as image generation. A `model_provider` line would switch provider, so Apply turns it off. Apply replaces an older apply's `[model_providers.spillway]` block.
- Codex login: Codex keeps its own ChatGPT login and sends it with every model call. The proxy accepts it when it is an unexpired auth.openai.com token for an account the proxy holds as a Codex credential, so Codex must be signed in to one of the pooled accounts. Account calls (usage, plan, plugins, apps) go to chatgpt.com directly. Apply and Undo remove the pool login earlier versions wrote to `auth.json`.
- A Codex process started before Apply or Undo keeps its old URLs; the page names the apps running Codex (a dev Electron app by its project folder). Restart them (in T3 Code, start a new Codex session).
- Changing the port or regenerating the key marks an applied client **Out of date**; Re-apply updates it. The app never rewrites these files on its own.
- Codex edits are text-level, not parsed TOML: a multi-line string containing a line that starts with `[` or one of those root keys can be misread.

Or set environment variables for Claude Code (the page copies them):

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:8317"
Remove-Item Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue
$env:ANTHROPIC_CUSTOM_HEADERS = "X-Api-Key: <client key from the Proxy page>"
```

## Updates

Settings → Updates checks this repo's [GitHub releases](https://github.com/Cujuju/spillway/releases) (`src/shared/updateFeed.ts`). Updates run on [`@cujuju/electron-updates`](https://github.com/Cujuju/solidjs-toolkit/tree/main/packages/electron-updates), the same path on every OS, downloading only chunks missing from the installed version. With **Check automatically** on, the app checks a minute after launch and every 6 hours and shows a notification. Nothing downloads or installs until you click.

- **Channel**: Nightly takes every published build (GitHub prereleases); Stable takes only promoted ones (the latest release). Switching to Stable never downgrades.
- Each update file is listed in the release's `update-<platform>.json`, with an Ed25519 signature over the app, version, platform, arch, file name, size and SHA-512. The app checks the listing against the public key built into it (`resources/update-public-key.pem`) before offering the update, and checks the download's hash before installing.
- **Download**, then **Restart and install**: the app quits (stopping the proxy) and applies the update, then reopens. Windows runs the installer silently. macOS swaps in the new app bundle, so ad-hoc signed builds update without Squirrel.Mac; the app must be in a folder you can write to, such as Applications.
- A build made without `resources/update-public-key.pem` cannot verify updates and never offers one.
- Someone with write access to this repo can withhold updates. They cannot get an unsigned file, an older version, or another app's file installed.

### Signing key (once)

```sh
pnpm release keygen
```

Writes the private key to `~/.config/spillway/update_key` (or `$SPILLWAY_UPDATE_KEY`) and the public key to `resources/update-public-key.pem`. Commit the public key so every build embeds it. Back up the private key outside the repo: installed copies accept updates only from it. Copy it to each machine that publishes (the Mac too).

### Release

Releases are built and published from your own machines; there is no CI release.

1. Commit and push. The version comes from git history (`appVersion.ts`).
2. On Windows: `pnpm package && pnpm release nightly`. On the Mac: the same. `release nightly` refuses unless `../solidjs-toolkit` and `../CLIProxyAPI` are clean at their latest pushed commit. Each uploads its platform's signed files to the prerelease `v<version>`, creating it if needed. Add `--dry-run` to see the `gh` commands first. Needs `gh` with push access to this repo.
3. Once a nightly has both platforms and you're happy with it: `pnpm release promote <version>` makes it the stable release (same files and signatures).

#### Scheduled nightly

`node scripts/nightly.mts install` on each machine (Windows Task Scheduler, macOS launchd) runs `node scripts/nightly.mts run` every 6 hours. Each run, in order:

1. If the newest nightly lacks this OS, publishes this OS for that release's commit, so Windows and macOS share one version.
2. Otherwise, if `main` moved past the newest release, publishes `main` as a new nightly.
3. Otherwise does nothing.

It builds clean worktrees of this repo and of `../solidjs-toolkit` and `../CLIProxyAPI` at their latest pushed commits (`../.spillway-nightly/`), so stale or uncommitted sibling code never ships, and publishes update files only; macOS disk images wait for a manual `pnpm release nightly`. The CI installer build runs on a stable release (promote) or a manual run.

- Log: `.git/spillway-nightly.log`. `node scripts/nightly.mts uninstall` removes the schedule.
- Each machine needs the signing key and `gh` with push access.

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
