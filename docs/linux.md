[← Spillway](../README.md)

# Linux

Linux x64 ships as `Spillway-<version>-x64.AppImage` in [stable releases](https://github.com/Cujuju/spillway/releases). Download it to a folder you can write to, mark it executable in your file manager, and open it. AppImage needs FUSE support from your distribution; see [AppImage's FUSE instructions](https://docs.appimage.org/user-guide/troubleshooting/fuse.html).

The tray uses Electron's StatusNotifierItem support, with a GtkStatusIcon fallback. Your desktop must provide a tray host; GNOME commonly needs an AppIndicator extension. The registered tray menu opens the window, controls the proxy, selects accounts and quits. Activation can be a click or double-click, depending on the desktop.

Settings → Startup → Launch at login writes `$XDG_CONFIG_HOME/autostart/dev.cujuju.spillway.desktop` (default `~/.config/autostart/`). It launches the original AppImage, with `--hidden` when Start minimized is on. Disabling launch at login removes that entry. After moving the AppImage, open it once to refresh the entry.

Settings and history live under `$XDG_CONFIG_HOME/Spillway` (default `~/.config/Spillway`). In-app updates replace the original AppImage after verifying its signed index and downloaded chunks; its containing folder must be writable.

Claude Code's system settings live at `/etc/claude-code/managed-settings.json`. Spillway uses its own `/etc/claude-code/managed-settings.d/spillway.json` drop-in, preserving other policies. Apply and Undo request administrator authentication through `pkexec`; install your distribution's polkit package and run a desktop authentication agent. See [Claude Code's managed-settings documentation](https://code.claude.com/docs/en/managed-settings).

## Build from source

Install Git, Node matching `package.json`, its pinned pnpm version, Go matching the fork's `go.mod`, and the native compiler tools needed by Electron's SQLite dependency. Clone the public repositories side by side:

- `Cujuju/spillway`
- `Cujuju/solidjs-toolkit`
- `Cujuju/CLIProxyAPI`

Run `pnpm install --frozen-lockfile` in the toolkit and Spillway, then, in Spillway:

```sh
unset ELECTRON_RUN_AS_NODE
node scripts/build-linked.mjs
pnpm proxy:build linux-x64
pnpm package
```

The proxy is built into `resources/bin/linux-x64/`; electron-builder packages that binary with the x64 AppImage. For development use `pnpm dev`. For data merging, select the installed AppImage with `pnpm data:merge --prod=/absolute/path/to/Spillway.AppImage`.
