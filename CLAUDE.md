# cliproxy-desktop

Electron 45 + SolidJS tray app supervising the CLIProxyAPI fork (Cujuju/CLIProxyAPI).

## Tracker
- GitHub Issues: `Cujuju/cliproxy-desktop`
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
- Proxy settings reach the proxy by rewriting `config.yaml` (`proxy.applyConfig()`); the proxy hot-reloads it. Don't add management PUTs for settings the app owns.

- Themes: one palette per theme in `src/shared/themes.ts`, used by the renderer (inline CSS vars) and the window background. Tints derive in `tokens.css`; don't hardcode colours.
- Email masking: the renderer's `snapshot` memo masks every credential field when "Show emails" is off, so views never handle raw emails. Main-process text (notifications) uses `maskEmails`.
- Proxy status has one indicator: the dot on the sidebar's Proxy item.

- Platforms: Windows and macOS. Proxy binaries live in `resources/bin/<platform>-<arch>/` (Node names); `scripts/build-proxy.mjs`, `electron-builder.yml` (`${platform}-${arch}`) and `src/main/paths.ts` must agree. UI wording for tray/taskbar comes from `src/renderer/src/lib/platform.ts`.

## Checks
`pnpm typecheck && pnpm test && pnpm build`. Unset `ELECTRON_RUN_AS_NODE` before launching Electron.
`pnpm proxy:build all` cross-compiles the proxy for every shipped target; macOS packaging only runs on a Mac.
