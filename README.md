# Spillway

Windows and macOS tray (menu bar) app that runs the private CLIProxyAPI fork, signs in subscription accounts, and shows their limits.

<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/images/dashboard-light.png">
  <img alt="Spillway dashboard with fake accounts: limits, forecast chart and per-account 5-hour and weekly bars" src="docs/images/dashboard-dark.png">
</picture>

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
- "Show emails" off hides every account email's username (`•••@example.com`) in the window, tray tooltips and notifications.

Provider logos come from [lobe-icons](https://github.com/lobehub/lobe-icons) (MIT); see `src/renderer/src/assets/providers/`.

| Activity | Providers |
|---|---|
| <picture><source media="(prefers-color-scheme: light)" srcset="docs/images/activity-light.png"><img alt="Activity page: cost, tokens, heatmap and models" src="docs/images/activity-dark.png"></picture> | <picture><source media="(prefers-color-scheme: light)" srcset="docs/images/providers-light.png"><img alt="Providers page: signed-in accounts and API keys" src="docs/images/providers-dark.png"></picture> |

Screenshots show fake data (`pnpm screenshots`).

## Docs

- **[Security and terms](docs/security.md)**: read this before you use Spillway.
- [Build and run](docs/setup.md): commands, dev builds, the fake-data demo, macOS.
- [Connect clients](docs/clients.md): point Claude Code and Codex at the proxy.
- [Updates and releases](docs/releasing.md): update channels, signing, nightly and stable releases.
- [Data](docs/data.md): where settings, keys, history and logs live.
