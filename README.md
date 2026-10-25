# CLIProxy Desktop

Windows tray app that runs the private CLIProxyAPI fork, signs in subscription accounts, and shows their limits.

- Runs and supervises `cli-proxy-api.exe`: starts it with the app, restarts it after a crash, and shuts it down cleanly on quit.
- Routes with the **soonest-reset** strategy and session affinity by default.
- Dashboard shows pool remaining, drain rate, a forecast chart, and per-account 5-hour and weekly bars.
- Accounts page signs in accounts through the browser (OAuth). You can rename, prioritise, disable or remove each one.
- Optional tray icons, one per limit: active account, pool average, least left, or one specific account.
- Launches at login, starts minimised, and closes or minimises to the tray.
- Ten colour themes (Midnight, Tonal, OLED Black, Nord, Dracula, Catppuccin Mocha and Latte, Solarized Dark and Light, Light), or follow Windows' light/dark mode.
- "Show emails" off masks every account email in the window, tray tooltips and notifications.

Provider logos come from [lobe-icons](https://github.com/lobehub/lobe-icons) (MIT); see `src/renderer/src/assets/providers/`.

## Run

| Task | Command |
|---|---|
| Install deps | `pnpm install` |
| Build the proxy into `resources/bin` | `pnpm proxy:build` (source: `CLIPROXY_SRC` or `../CLIProxyAPI`) |
| Dev, with hot reload | `pnpm dev` |
| Installer | `pnpm package` → `dist/CLIProxy Desktop Setup <ver>.exe` |
| Checks | `pnpm typecheck`, `pnpm test` |

`pnpm dev` breaks if the environment has `ELECTRON_RUN_AS_NODE` set: Electron then runs as plain Node. Unset it first.

Launch at login only applies to installed builds.

## Connect Claude Code

The Proxy page shows the endpoint and the client key, and copies them as environment variables:

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:8317"
$env:ANTHROPIC_AUTH_TOKEN = "<client key from the Proxy page>"
```

## Data

Everything lives in `%APPDATA%\CLIProxy Desktop`:

| Item | Path |
|---|---|
| Settings | `settings.json` |
| Keys | `secrets.bin`, DPAPI-encrypted |
| Usage history | `usage-history.json` |
| Generated proxy config | `proxy/config.yaml` |
| Account logins | `proxy/auths/` |
| Logs | `proxy/proxy.log` (previous run: `proxy.prev.log`) |

`config.yaml` is rewritten on every start, so change settings in the app rather than in the file.
