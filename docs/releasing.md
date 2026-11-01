[← Spillway](../README.md)

# Updates and releases

Settings → Updates checks this repo's [GitHub releases](https://github.com/Cujuju/spillway/releases) (`src/shared/updateFeed.ts`). Updates run on [`@cujuju/electron-updates`](https://github.com/Cujuju/solidjs-toolkit/tree/main/packages/electron-updates), the same path on every OS, downloading only chunks missing from the installed version. With **Check automatically** on, the app checks a minute after launch and every 6 hours and shows a notification. Nothing downloads or installs until you click.

- **Channel**: Nightly takes every published build (GitHub prereleases); Stable takes only promoted ones (the latest release). Switching to Stable never downgrades.
- Each update file is listed in the release's `update-<platform>.json`, with an Ed25519 signature over the app, version, platform, arch, file name, size and SHA-512. The app checks the listing against the public key built into it (`resources/update-public-key.pem`) before offering the update, and checks the download's hash before installing.
- **Download**, then **Restart and install**: the app quits (stopping the proxy) and applies the update, then reopens. Windows runs the installer silently. macOS swaps in the new app bundle, so ad-hoc signed builds update without Squirrel.Mac; the app must be in a folder you can write to, such as Applications.
- A build made without `resources/update-public-key.pem` cannot verify updates and never offers one.
- Someone with write access to this repo can withhold updates. They cannot get an unsigned file, an older version, or another app's file installed.

## Signing key (once)

```sh
pnpm release keygen
```

Writes the private key to `~/.config/spillway/update_key` (or `$SPILLWAY_UPDATE_KEY`) and the public key to `resources/update-public-key.pem`. Commit the public key so every build embeds it. Back up the private key outside the repo: installed copies accept updates only from it. Copy it to each machine that publishes (the Mac too).

## Release

Releases are built and published from your own machines; there is no CI release.

1. Commit and push. The version comes from git history (`appVersion.ts`).
2. On Windows: `pnpm package && pnpm release nightly`. On the Mac: the same. `release nightly` refuses unless `../solidjs-toolkit` and `../CLIProxyAPI` are clean at their latest pushed commit. Each uploads its platform's signed files to the prerelease `v<version>`, creating it if needed. Add `--dry-run` to see the `gh` commands first. Needs `gh` with push access to this repo.
3. Once a nightly has both platforms and you're happy with it: `pnpm release promote <version>` makes it the stable release (same files and signatures). Run it from `main`: it first refreshes the screenshots in `docs/images/`, commits any that changed and pushes `main`.

### Scheduled nightly

`node scripts/nightly.mts install` on each machine (Windows Task Scheduler, macOS launchd) runs `node scripts/nightly.mts run` every 6 hours. Each run, in order:

1. If the newest nightly lacks this OS, publishes this OS for that release's commit, so Windows and macOS share one version.
2. Otherwise, if `main` moved past the newest release, publishes `main` as a new nightly.
3. Otherwise does nothing.

It builds clean worktrees of this repo and of `../solidjs-toolkit` and `../CLIProxyAPI` at their latest pushed commits (`../.spillway-nightly/`), so stale or uncommitted sibling code never ships, and publishes update files only; macOS disk images wait for a manual `pnpm release nightly`. The CI installer build runs on a stable release (promote) or a manual run.

- Log: `.git/spillway-nightly.log`. `node scripts/nightly.mts uninstall` removes the schedule.
- Each machine needs the signing key and `gh` with push access.
