[← Spillway](../README.md)

# Updates and releases

Settings → Updates checks this repo's [GitHub releases](https://github.com/Cujuju/spillway/releases) (`src/shared/updateFeed.ts`). Updates run on [`@cujuju/electron-updates`](https://github.com/Cujuju/solidjs-toolkit/tree/main/packages/electron-updates), downloading only chunks missing from the installed version. With **Check automatically** on, the app checks a minute after launch and every 6 hours. Nothing downloads or installs until you click.

- **Channel**: Nightly takes published prereleases; Stable takes promoted releases. Switching to Stable never downgrades.
- `update-win32.json`, `update-darwin.json` and `update-linux.json` list signed indexes. Ed25519 signatures bind the app, version, platform, architecture, file name, size and SHA-512. The app checks the committed public key (`resources/update-public-key.pem`) before offering an update and checks downloaded hashes.
- **Download**, then **Restart and install** stops the proxy and applies the update. Windows runs its installer silently; macOS swaps the unpacked app bundle; Linux replaces the original AppImage. macOS and Linux need a writable containing folder.
- A build without the public key cannot verify updates and never offers one.

### Troubleshooting

- **Invalid package …/app.asar during download**: older updater builds use Electron's virtual archive filesystem while rebuilding the app. The updater must use `original-fs` for the bundle's raw bytes. An affected installed copy needs a manual installer replacement to get that fix; changing the signing key will not repair it.
- **GitHub build never starts**: check whether the workflow is enabled and read the run's annotations for billing or spending-limit blocks. CI publishes signed nightly updates using the repository secret `SPILLWAY_UPDATE_KEY`; installer-only runs do not use the signing key. Nightlies are scheduled by GitHub Actions, with no machine-local scheduled publishers.

## Signing key

`pnpm release keygen` creates a private key outside the repo (`~/.config/spillway/update_key`, or the path in `SPILLWAY_UPDATE_KEY`) and writes its public half to `resources/update-public-key.pem`. Commit only the public key and back up the private key outside the repo. Installed copies keep trusting that key.

GitHub Actions uses the repository secret **SPILLWAY_UPDATE_KEY**, containing the private key's PEM contents. The workflow writes it privately into runner temp storage, passes that path as `SPILLWAY_UPDATE_KEY`, and removes the file after publishing. It never logs the contents.

## Nightlies in GitHub Actions

The **releases** workflow (`.github/workflows/build.yml`) runs every 3 hours and supports **Run workflow → nightly**. Scheduled runs:

1. Finish any missing platform manifests on the newest prerelease, building its original tagged commit even if main has advanced.
2. Otherwise publish origin/main if it differs from the newest release's commit.
3. Otherwise skip.

The plan job fetches complete git history, derives the deterministic version through `appVersion.ts`, and creates one prerelease at that exact SHA. `scripts/releaseShared.mts` supplies the same title, notes and target for CI and the local release CLI. Platform jobs then build Windows x64, macOS arm64/x64 and Linux x64, and run `SPILLWAY_UPDATE_ONLY=1 pnpm release nightly` to upload signed updates. Full installers wait for stable releases.

The public fork and toolkit are checked out from their default branches as siblings; no source-access secret is needed. Every platform job fetches upstream's `v*` tags into the proxy fork before building, so the proxy can report its upstream version without adding release tags to the fork. The release guard requires clean siblings at their latest pushed default-branch commits and discovers `origin/HEAD` when CI checkouts omit it. Workflow concurrency serializes release runs.

A manual nightly builds main even when it has not changed; completed platform uploads are preserved. An already-stable source has no new nightly to publish. The old machine-local scheduler has been retired; the workflow owns the nightly schedule.

When introducing Linux support, run a manual nightly once from the updated main. Earlier prerelease commits cannot build Linux; the manual run starts the new version instead of resuming one of those commits.

## Stable releases

Once a nightly has all three platform manifests, run `pnpm release promote <version>` from main. It builds the fake-data demo screenshots, commits changed images, pushes main, and only then promotes the existing nightly. A rejected push stops promotion. `--dry-run` skips the screenshot writes and publication.

Promotion emits `release: released`, triggering the same workflow to build full Windows Setup exe, both macOS dmg/zip architectures, and Linux x64 AppImage installers from the release tag's source commit and attach them to that release. The screenshot commit does not change that source tag. Updates retain their existing signatures and files.

macOS keeps both DMG and ZIP downloads for manual installation. ZIP archives provide an alternative to mounting a disk image; macOS updates still rebuild the unpacked app bundle and do not use either installer format.

For installer retries, choose **Run workflow → installers**, optionally naming a stable tag (otherwise the latest stable). This rebuilds installers and replaces matching installer assets; it does not replace update manifests or packs.

For a local nightly, install and build the toolkit, build this platform's proxy, run `pnpm package`, then `pnpm release nightly` from a clean pushed commit with clean current siblings. Set `SPILLWAY_UPDATE_KEY` to the private key's path. Needs `gh` with write access; `--dry-run` previews publication commands.
