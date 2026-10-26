# spillway

Electron 45 + SolidJS tray app supervising the CLIProxyAPI fork (Cujuju/CLIProxyAPI).

## Tracker
- GitHub Issues: `Cujuju/spillway`
- Buckets: `area/supervisor`, `area/ui`
- Kinds: `kind/feature`, `bug`
- Arc: `arc/account-rotation`

## Layout
- `src/main/`: proxy supervisor, management client, usage poller, tray, IPC.
- `src/preload/`: generic `window.api` built from `src/shared/ipc.ts`.
- `src/renderer/`: Solid UI (pages, components, lib).
- `src/shared/`: types, settings schema and normalizer, tray readings.

## Contracts
- Proxy management API: `docs/desktop-api.md` in the fork.
- v8 `PUT /config/<path>` replaces the node with the raw JSON body, so send the value unwrapped (no `{value}`).
- The app authenticates with a per-launch supervisor password (`MANAGEMENT_SUPERVISOR_PASSWORD`), exempt from the loopback IP ban. Other wrong keys still ban 127.0.0.1 for 30 minutes.
- Outside tools (T3 Code's CLIProxyAPI usage hub) use the stable `managementKey` in `secrets.bin`, written to `management.secret-key`; never rotate it per launch.
- Codex keeps its built-in OpenAI provider, pointed at the proxy with `openai_base_url = <endpoint>/backend-api/codex`. Never apply a custom `model_provider`: Codex offers some tools (image generation) only on its OpenAI provider or a login-based one. Never write the key into `config.toml`.
- Codex authenticates model calls and account calls (usage, plan, via `chatgpt_base_url` = `/backend-api/`) with the pool login Apply writes to `auth.json` (`src/main/codexPoolAuth.ts`). Its token derives from the client key and must stay in `access.api-keys`. Codex's own ChatGPT login is never used.
- Claude Code gets the client key as `ANTHROPIC_CUSTOM_HEADERS: X-Api-Key: <key>` (`src/shared/claudeEnv.ts`), never `ANTHROPIC_AUTH_TOKEN`: token mode drops Claude Code out of its subscription login, and it then ignores the proxy's usage-limit headers (T3 Code snooze).
- Versions (sidebar card): `scripts/build-proxy.mjs` stamps the proxy with the newest upstream `v*` tag in the fork and the fork's build ID (`gitBuild` in `appVersion.ts`, `-dirty` when built from uncommitted changes); the app reads them from the `X-CPA-*` management headers. Never add `v*` tags to the fork.
- Proxy settings reach the proxy by rewriting `config.yaml` (`proxy.applyConfig()`); the proxy hot-reloads it. Don't add management PUTs for settings the app owns.

- Themes: one palette per theme in `src/shared/themes.ts`, used by the renderer (inline CSS vars) and the window background. Tints derive in `tokens.css`; don't hardcode colours.
- Email masking: the renderer's `snapshot` memo masks every credential field when "Show emails" is off, so views never handle raw emails. Main-process text (notifications) uses `maskEmails`.
- Proxy status has one indicator: the dot on the sidebar's Proxy item.

- Platforms: Windows and macOS. Proxy binaries live in `resources/bin/<platform>-<arch>/` (Node names); `scripts/build-proxy.mjs`, `electron-builder.yml` (`${platform}-${arch}`) and `src/main/paths.ts` must agree. UI wording for tray/taskbar comes from `src/renderer/src/lib/platform.ts`.

## Checks
`pnpm typecheck && pnpm test && pnpm build`. Unset `ELECTRON_RUN_AS_NODE` before launching Electron.
`pnpm proxy:build all` cross-compiles the proxy for every shipped target; macOS packaging only runs on a Mac.

## Commits
Commit your own changes as soon as the checks pass, without being asked. Other sessions share this checkout, so stage only your own paths and hunks.
