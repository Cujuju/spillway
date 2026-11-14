# spillway

Electron 45 + SolidJS tray app supervising the CLIProxyAPI fork (Cujuju/CLIProxyAPI).

## Tracker
- GitHub Issues: `Cujuju/spillway`
- Buckets: `area/supervisor`, `area/ui`
- Kinds: `kind/feature`, `bug`
- Arcs: `arc/account-rotation`, `arc/model-drift`

## Layout
- `src/main/`: proxy supervisor, management client, usage poller, tray, IPC.
- `src/preload/`: generic `window.api` built from `src/shared/ipc.ts`.
- `src/renderer/`: Solid UI (pages, components, lib).
- `src/shared/`: types, settings schema and normalizer, tray readings.

## Contracts
- Data transfer: `--data-export=<file>` / `--data-import=<file>`, with a 64-hex `SPILLWAY_TRANSFER_KEY`; each app only ever opens its own database.
- Proxy management API: `docs/desktop-api.md` in the fork.
- v8 `PUT /config/<path>` replaces the node with the raw JSON body, so send the value unwrapped (no `{value}`).
- The app authenticates with a per-launch supervisor password (`MANAGEMENT_SUPERVISOR_PASSWORD`), exempt from the loopback IP ban. Other wrong keys still lock 127.0.0.1 out (5 minutes after 5, then 30 minutes after 3); the Proxy page can reset it.
- Outside tools (T3 Code's CLIProxyAPI usage hub) use the stable `managementKey` in `secrets.bin`, written to `management.secret-key`; never rotate it per launch.
- The dev build's proxy uses production's client keys, management secret (bcrypt hash) and auth dir, read from production's `proxy/config.yaml` (`src/main/proxyIdentity.ts`), else its own. Only one proxy runs at a time. The app's client key stays first in `access.api-keys`.
- Codex keeps its built-in OpenAI provider, pointed at the proxy with `openai_base_url = <endpoint>/backend-api/codex`. Never apply a custom `model_provider`: Codex offers some tools (image generation) only on its OpenAI provider or a login-based one. Never write the key into `config.toml`.
- Codex keeps its own ChatGPT login (`auth.json`). The proxy's `codex-login` access provider accepts it on model calls: an OpenAI-signed token for an account the proxy holds as a Codex credential. Account calls (usage, plan) go to chatgpt.com directly, so Apply never sets `chatgpt_base_url`. Codex requires that URL to be https for a real login. Apply and Undo retire the old pool login (`src/main/codexPoolAuth.ts`); never write `auth.json`.
- Claude Code gets the client key as `ANTHROPIC_CUSTOM_HEADERS: X-Api-Key: <key>` (`src/shared/claudeEnv.ts`), never `ANTHROPIC_AUTH_TOKEN`: token mode drops Claude Code out of its subscription login, and it then ignores the proxy's usage-limit headers (T3 Code snooze).
- Versions (sidebar card): `scripts/build-proxy.mjs` stamps the proxy with the newest upstream `v*` tag in the fork and the fork's build ID (`gitBuild` in `appVersion.ts`, `-dirty` when built from uncommitted changes); the app reads them from the `X-CPA-*` management headers. Never add `v*` tags to the fork.
- Window starts (`src/main/windowStarter.ts`): when a 5-hour `on_use` window is idle, the app calls the fork's `POST /usage/start-window`. Those requests carry `purpose: "window-start"` and stay out of Activity.
- Updates: `@cujuju/electron-updates` (toolkit), signed chunk updates on every OS; macOS rebuilds the app bundle, Linux replaces the AppImage. GitHub Actions (`.github/workflows/build.yml`) checks main every 3 hours, retries missing platforms while main matches the newest prerelease, and publishes `v<version>` from one source commit with the public toolkit and fork at their latest default branches. `scripts/releaseShared.mts` shares release metadata with the local CLI. `promote` refreshes demo screenshots into an auto-merge PR (`release/screenshots-v<version>`; main takes only PRs), then makes the nightly stable without waiting for it, triggering CI for extra macOS DMG/ZIP installers; manual workflows can publish nightlies or missing stable installers. Feed and signature context: `src/shared/updateFeed.ts`.
- Drift (Activity → Drift) reads retained requests only; canary probes (`src/main/canaryService.ts`) send `X-CPA-Purpose: canary`, which the fork marks `purpose: "canary"` so they stay out of Activity.
- Proxy settings reach the proxy by rewriting `config.yaml` (`proxy.applyConfig()`); the proxy hot-reloads it. Don't add management PUTs for settings the app owns.

- Themes: one palette per theme in `src/shared/themes.ts`, used by the renderer (inline CSS vars) and the window background. Tints derive in `tokens.css`; don't hardcode colours.
- Email masking: the renderer's `snapshot` memo masks every credential field when "Show emails" is off, so views never handle raw emails. Main-process text (notifications) uses `maskEmails`.
- Notifications: the overlay is the linked toolkit package `@cujuju/electron-notices` (generic; no Spillway concepts). Every notice goes through `notify()` (`src/main/notifier.ts`), built with `spillwayNotice()` (`src/shared/notice.ts`: kind → tone, tag, icon; theme → `--notice-*` vars); never `new Notification` elsewhere. Delivery and style are settings. The overlay page (`src/renderer/src/notice/`) only mounts `NoticeOverlay` with Spillway's icons; its bridge is `window.notices` from the preload.
- Proxy status has one indicator: the sidebar's Proxy icon, tinted by state.
- About (Settings → About; macOS app menu opens it): credits live in `src/renderer/src/lib/credits.ts`, one entry per contributor. Logo sizes come from `scripts/make-icon.ps1`.
- License notices ship in `licenses/` (`electron-builder.ts`; `beforePack` fails without them): npm packages per bundle from `rollup-plugin-license` (`electron.vite.config.ts`), Go modules from `go-licenses` (`scripts/build-proxy.mjs`). A Go module released without a LICENSE gets one in `scripts/go-license-overrides/<module>/`.

- Demo and screenshots (`docs/setup.md`): `pnpm demo` runs the app on fake data from `scripts/demo/` (fake proxy, attached with `--proxy-endpoint`); `pnpm demo --screenshots` writes `docs/images/`; `pnpm smoke` is the boot check (see Checks); and `release promote` refreshes them and opens an auto-merge PR. New management calls the app makes need a fake answer in `scripts/demo/server.mts`.

- Platforms: Windows x64, macOS arm64/x64 and Linux x64 (AppImage). Proxy binaries live in `resources/bin/<platform>-<arch>/` (Node names); `scripts/build-proxy.mjs`, `electron-builder.ts` (`${platform}-${arch}`) and `src/main/paths.ts` must agree. UI wording for tray/taskbar comes from `src/renderer/src/lib/platform.ts`. Linux uses XDG autostart and pkexec for Claude Code's managed policy under `/etc/claude-code/`.

## Checks
`pnpm lint && pnpm typecheck && pnpm test && pnpm smoke` (`smoke` builds first). Unset `ELECTRON_RUN_AS_NODE` before launching Electron.
Never report done, or commit, without a passing `pnpm smoke` this session; quote its `smoke: ok` line. It boots the built app on a throwaway profile and the fake proxy, opens every page, and fails on a crash or uncaught renderer error. It doesn't cover the `electron-vite dev` server: after changing `electron.vite.config.ts`, also start `pnpm dev`.
`pnpm lint` is oxlint with the StockApp/MoManga/ChattyPop rule set (`.oxlintrc.json`); warnings fail it.
`pnpm typecheck` first rebuilds the `link:` toolkit packages (`scripts/build-linked.mjs`): their types come from their gitignored `dist/`.
`pnpm proxy:build all` cross-compiles the proxy for every shipped target; macOS packaging only runs on a Mac.

## Commits
Commit your own changes as soon as the checks pass, without being asked. Other sessions share this checkout, so stage only your own paths and hunks.
