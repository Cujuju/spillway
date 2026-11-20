import { randomUUID } from 'node:crypto';
import { constants, readFileSync } from 'node:fs';
import { cp, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const ACTIVITY_FILES = {
  database: 'activity.db', legacy: 'activity', history: 'usage-history.json',
  summaries: 'window-summaries.json', observed: 'observed-spans.json', proxy: 'proxy',
} as const;
const CAPTURE_FILES = ['captures.db', 'proxy.log', 'proxy.prev.log'];
const DATABASE_FILES = /^activity\.db(?:(?:\.pre-merge-\d+|\.unreadable-\d+)?(?:-wal|-shm|-journal)?|(?:-wal|-shm)\.pre-merge-\d+)$/;
const MARKER = '.spillway-storage';
const PROFILE_FILE = 'activity-storage.json';
const DEFAULT_FOLDER = 'Spillway Data';
const LOCATION_ID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/;

interface Location { directory: string; id: string }
export interface StorageDestination { directory: string; parentIdentity: string }
type PendingMove = Location & StorageDestination;
interface StorageState { active: Location | null; pending?: PendingMove; cleanup?: { source: Location | null; filesRemoved?: true } }

const hasCode = (error: unknown, code: string) => (error as NodeJS.ErrnoException).code === code;
const readOptional = (file: string) => readFile(file, 'utf8').catch((error: unknown) => {
  if (!hasCode(error, 'ENOENT')) throw error;
});
const statOptional = (file: string) => lstat(file).catch((error: unknown) => {
  if (!hasCode(error, 'ENOENT')) throw error;
});

function validLocation(location: Location | null): boolean {
  return location === null || typeof location?.directory === 'string' && path.isAbsolute(location.directory)
    && typeof location.id === 'string' && LOCATION_ID.test(location.id);
}

/** Only Spillway's growing data is movable. Profile and proxy configuration keep their original paths. */
async function storageEntries(directory: string): Promise<string[]> {
  const files = (await readdir(directory)).filter((name) => DATABASE_FILES.test(name)
    || name === ACTIVITY_FILES.legacy || name === ACTIVITY_FILES.history || name === ACTIVITY_FILES.summaries || name === ACTIVITY_FILES.observed);
  const proxy = path.join(directory, ACTIVITY_FILES.proxy);
  const stat = await statOptional(proxy);
  if (stat && !stat.isDirectory()) throw new Error(`Expected a directory at ${proxy}`);
  if (stat) files.push(...(await readdir(proxy)).filter((name) => CAPTURE_FILES.includes(name)).map((name) => path.join(ACTIVITY_FILES.proxy, name)));
  return files;
}

class StorageMoveError extends Error {}

export class ActivityStorage {
  private state: StorageState = { active: null };
  constructor(private root: string) {}

  get directory(): string { return this.state.active?.directory ?? this.root; }
  get defaultDirectory(): string { return this.state.active ? path.join(this.root, DEFAULT_FOLDER) : this.root; }
  private get stateFile(): string { return path.join(this.root, PROFILE_FILE); }

  private async save(state: StorageState): Promise<void> {
    const temporary = `${this.stateFile}.tmp`;
    const file = await open(temporary, 'w', 0o600);
    try { await file.writeFile(JSON.stringify(state)); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, this.stateFile);
    this.state = state;
  }

  /** Both the app and transfer CLI initialize under the single-instance lock before opening data. */
  async initialize(): Promise<string | undefined> {
    this.root = await realpath(this.root).catch((error: unknown) => {
      if (!hasCode(error, 'ENOENT')) throw error;
      return this.root;
    });
    const raw = await readOptional(this.stateFile);
    const next = raw === undefined ? { active: null } : JSON.parse(raw) as StorageState;
    if (!next || !validLocation(next.active) || (next.pending !== undefined && (!next.pending || !validLocation(next.pending)
      || typeof next.pending.parentIdentity !== 'string'))
      || (next.cleanup !== undefined && !validLocation(next.cleanup?.source))) {
      throw new Error(`Invalid storage configuration at ${this.stateFile}`);
    }
    this.state = next;
    let warning: string | undefined;
    if (next.pending) {
      try { await this.finishMove(next.pending); }
      catch (error) {
        if (!(error instanceof StorageMoveError)) throw error;
        warning = error.message;
      }
    }
    this.verifyActive();
    return (await this.cleanSource()) ?? warning;
  }

  async destination(selected: string, useDefault: boolean): Promise<StorageDestination | null> {
    if (this.state.cleanup) throw new Error('Spillway still needs to remove the old copies after the last move. Restart with both drives connected.');
    const source = await realpath(this.directory);
    const root = await realpath(this.root);
    const parent = useDefault ? root : await realpath(selected);
    const directory = path.join(parent, DEFAULT_FOLDER);
    // relative() honors Windows path casing and realpath resolves junctions and symlinks first.
    if (!path.relative(source, directory)) return null;
    const within = (parent: string) => {
      const relative = path.relative(parent, directory);
      return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
    };
    if (!useDefault && path.relative(path.join(root, DEFAULT_FOLDER), directory) && within(root)) {
      throw new Error('Choose a folder outside the Spillway profile.');
    }
    if (this.state.active && within(source)) {
      throw new Error('Choose a folder outside the current storage folder.');
    }
    await this.requireNewDirectory(directory);
    return { directory, parentIdentity: await this.parentIdentity(parent) };
  }

  async schedule(destination: StorageDestination): Promise<void> {
    await this.save({ ...this.state, pending: { ...destination, id: randomUUID() } });
  }

  private async parentIdentity(directory: string): Promise<string> {
    const info = await lstat(directory, { bigint: true });
    if (!info.isDirectory()) throw new Error(`Storage destination unavailable: ${directory}`);
    return `${info.dev}:${info.ino}`;
  }

  private async requireNewDirectory(directory: string): Promise<void> {
    if (await statOptional(directory)) throw new Error(`${directory} already exists. Choose another folder.`);
  }

  verifyActive(): void {
    const active = this.state.active;
    if (!active) return;
    try {
      if (readFileSync(path.join(active.directory, MARKER), 'utf8') === active.id) return;
    } catch (error) {
      if (!hasCode(error, 'ENOENT') && !hasCode(error, 'ENOTDIR')) throw error;
    }
    throw new Error(`Storage folder unavailable: ${active.directory}. Reconnect the drive and open Spillway again.`);
  }

  private async finishMove(target: PendingMove): Promise<void> {
    // A published directory is complete even if Spillway exited before switching the profile pointer.
    const parent = path.dirname(target.directory);
    const staging = path.join(parent, `.spillway-move-${target.id}`);
    let mayCleanStaging = false;
    try {
      if (await this.parentIdentity(parent) !== target.parentIdentity) throw new Error(`Storage destination changed: ${parent}`);
      mayCleanStaging = true;
      const info = await statOptional(target.directory);
      const published = info?.isDirectory() && await readOptional(path.join(target.directory, MARKER)) === target.id;
      if (!published) {
        this.verifyActive();
        await this.requireNewDirectory(target.directory);
        // A prior interrupted copy uses this reserved path from the same journal entry.
        await rm(staging, { recursive: true, force: true });
        await mkdir(staging, { mode: 0o700 });
        await mkdir(path.join(staging, ACTIVITY_FILES.proxy), { mode: 0o700 });
        for (const name of await storageEntries(this.directory)) {
          await cp(path.join(this.directory, name), path.join(staging, name), {
            recursive: true, force: false, errorOnExist: true, mode: constants.COPYFILE_FICLONE,
            filter: async (file) => {
              const info = await lstat(file);
              if (!info.isFile() && !info.isDirectory()) throw new Error(`Unsupported storage entry at ${file}`);
              return true;
            },
          });
        }
        await writeFile(path.join(staging, MARKER), target.id, { flag: 'wx', mode: 0o600 });
        await this.requireNewDirectory(target.directory);
        await rename(staging, target.directory);
      }
    } catch (error) {
      if (mayCleanStaging) await rm(staging, { recursive: true, force: true }).catch(console.error);
      await this.save({ active: this.state.active });
      throw new StorageMoveError(`Could not move data to ${target.directory}. Spillway will continue using ${this.directory}. ${String(error)}`);
    }
    // The old files are removable only after future launches will use the complete destination.
    await this.save({ active: { directory: target.directory, id: target.id }, cleanup: { source: this.state.active } });
  }

  private async cleanSource(): Promise<string | undefined> {
    if (!this.state.cleanup) return;
    const { source, filesRemoved } = this.state.cleanup;
    const directory = source?.directory ?? this.root;
    try {
      if (!filesRemoved) {
        if (source && await readOptional(path.join(directory, MARKER)) !== source.id) {
          throw new Error('Reconnect the original drive with its Spillway storage folder.');
        }
        for (const name of await storageEntries(directory)) await rm(path.join(directory, name), { recursive: true, force: true });
        await this.save({ active: this.state.active, cleanup: { source, filesRemoved: true } });
      }
      if (source && await readOptional(path.join(directory, MARKER)) === source.id) {
        await rmdir(path.join(directory, ACTIVITY_FILES.proxy)).catch((error: unknown) => {
          if (!hasCode(error, 'ENOENT') && !hasCode(error, 'ENOTEMPTY')) console.error(error);
        });
        await rm(path.join(directory, MARKER), { force: true });
        await rmdir(directory).catch((error: unknown) => {
          if (!hasCode(error, 'ENOENT') && !hasCode(error, 'ENOTEMPTY')) throw error;
        });
      }
      await this.save({ active: this.state.active });
    } catch (error) { return `Data moved to ${this.directory}. Could not finish cleaning up ${directory}. ${String(error)}`; }
  }
}
