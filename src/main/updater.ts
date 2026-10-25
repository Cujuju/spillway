/**
 * Update checks against the electron-builder.yml `publish` repo; downloads are verified with the built-in Ed25519 key.
 * Windows installs. macOS (ad-hoc signed, so no Squirrel.Mac) only downloads the disk image.
 */
import { app, net, shell } from 'electron';
import electronUpdater, { type AppUpdater, type UpdateInfo } from 'electron-updater';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { createWriteStream, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parse } from 'yaml';
import type { UpdateStatus } from '@shared/types';
import { releaseTag, sha512File, verifyFile, type SignedFileInfo } from './updateRelease';

const UPDATE_PUBLIC_KEY = __UPDATE_PUBLIC_KEY__;
/** Releases are manual and rare; a few checks a day still finds one the same day. */
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60_000;
/** Lets a login launch settle (proxy start, first usage poll) before the first check. */
const STARTUP_CHECK_DELAY_MS = 60_000;
const PERCENT = 100;
const isMac = process.platform === 'darwin';
/** States in which a check would discard progress or a verified download. */
const BUSY: readonly UpdateStatus['state'][] = ['checking', 'downloading', 'ready', 'saved'];

const events = new EventEmitter<{ status: [UpdateStatus]; found: [string] }>();
let status: UpdateStatus = { state: 'idle' };
let latest: UpdateInfo | null = null;
let timer: NodeJS.Timeout | null = null;
let client: AppUpdater | null = null;

function set(next: UpdateStatus): void {
  status = next;
  events.emit('status', next);
}

function unavailableReason(): string | null {
  if (!app.isPackaged) return 'Updates are checked in installed builds only.';
  if (!UPDATE_PUBLIC_KEY) return 'This build has no update public key, so it cannot verify updates.';
  return null;
}

/** First line only: electron-updater appends whole HTTP responses to its messages. */
const describe = (err: unknown): string => String((err as Error)?.message ?? err).split('\n')[0] ?? '';

/** Created on first use: electron-updater reads app-update.yml, which only installed builds have. */
function getClient(): AppUpdater {
  if (client) return client;
  client = electronUpdater.autoUpdater;
  // Nothing downloads or installs without the user, and only after verification.
  client.autoDownload = false;
  client.autoInstallOnAppQuit = false;
  client.on('download-progress', (p) => {
    if (status.state === 'downloading') set({ ...status, percent: Math.floor(p.percent) });
  });
  return client;
}

async function check(): Promise<void> {
  if (unavailableReason() || BUSY.includes(status.state)) return;
  set({ state: 'checking' });
  try {
    const result = await getClient().checkForUpdates();
    latest = result?.isUpdateAvailable ? result.updateInfo : null;
    set(latest ? { state: 'available', version: latest.version } : { state: 'up-to-date', checkedAt: new Date().toISOString() });
  } catch (err) {
    set({ state: 'error', message: describe(err) });
  }
}

/** The listing entry for a downloaded file is the one with its hash; any other entry fails verification. */
function verifyDownload(info: UpdateInfo, actualSha512: string, preferred?: SignedFileInfo): string | null {
  const files = info.files as SignedFileInfo[];
  const entry = files.find((f) => f.sha512 === actualSha512) ?? preferred ?? files[0];
  return entry ? verifyFile(UPDATE_PUBLIC_KEY, info.version, entry, actualSha512) : 'the release lists no files';
}

async function downloadWindows(info: UpdateInfo): Promise<void> {
  const [file] = await getClient().downloadUpdate();
  if (!file) throw new Error('the download produced no file');
  const problem = verifyDownload(info, await sha512File(file));
  if (problem) {
    rmSync(file, { force: true });
    throw new Error(`Update ${info.version} was rejected: ${problem}`);
  }
  set({ state: 'ready', version: info.version });
}

/** Owner and repo from the app-update.yml electron-builder writes from the `publish` config. */
function feedRepo(): { owner: string; repo: string } {
  const feed = parse(readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8')) as { owner?: string; repo?: string };
  if (!feed.owner || !feed.repo) throw new Error('app-update.yml has no GitHub owner and repo');
  return { owner: feed.owner, repo: feed.repo };
}

/** Disk image for this Mac's architecture (artifact names end in -<arch>.dmg). */
function macImage(info: UpdateInfo): SignedFileInfo {
  const images = (info.files as SignedFileInfo[]).filter((f) => f.url.endsWith('.dmg'));
  const image = images.find((f) => f.url.endsWith(`-${process.arch}.dmg`)) ?? images[0];
  if (!image) throw new Error(`release ${info.version} has no disk image`);
  return image;
}

async function downloadMac(info: UpdateInfo): Promise<void> {
  const image = macImage(info);
  const { owner, repo } = feedRepo();
  const url = `https://github.com/${owner}/${repo}/releases/download/${releaseTag(info.version)}/${encodeURIComponent(image.url)}`;
  const res = await net.fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const dest = path.join(app.getPath('downloads'), image.url);
  const partial = `${dest}.download`;
  const hash = createHash('sha512');
  let received = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      hash.update(chunk);
      received += chunk.length;
      if (total) set({ state: 'downloading', version: info.version, percent: Math.floor((received / total) * PERCENT) });
      done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), meter, createWriteStream(partial));
    const problem = verifyDownload(info, hash.digest('base64'), image);
    if (problem) throw new Error(`Update ${info.version} was rejected: ${problem}`);
    renameSync(partial, dest);
  } catch (err) {
    rmSync(partial, { force: true });
    throw err;
  }
  set({ state: 'saved', version: info.version, file: dest });
}

async function download(): Promise<void> {
  const info = latest;
  if (status.state !== 'available' || !info) return;
  set({ state: 'downloading', version: info.version, percent: 0 });
  try {
    await (isMac ? downloadMac(info) : downloadWindows(info));
  } catch (err) {
    set({ state: 'error', message: describe(err) });
  }
}

async function autoCheck(): Promise<void> {
  const before = status;
  await check();
  const after = status;
  if (after.state === 'available' && !(before.state === 'available' && before.version === after.version)) events.emit('found', after.version);
}

export const updates = {
  on: events.on.bind(events),
  status: (): UpdateStatus => {
    const reason = unavailableReason();
    return reason ? { state: 'unavailable', reason } : status;
  },
  check,
  download,
  /** Windows: runs the verified installer and quits. macOS: opens the verified disk image. */
  async install(): Promise<void> {
    if (status.state === 'saved') {
      const error = await shell.openPath(status.file);
      if (error) set({ state: 'error', message: error });
    } else if (status.state === 'ready') {
      getClient().quitAndInstall();
    }
  },
  /** Starts or stops the periodic check; the first runs shortly after launch. */
  setAutoCheck(enabled: boolean): void {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!enabled || unavailableReason()) return;
    const tick = () => {
      void autoCheck();
      timer = setTimeout(tick, AUTO_CHECK_INTERVAL_MS);
    };
    timer = setTimeout(tick, STARTUP_CHECK_DELAY_MS);
  },
};
