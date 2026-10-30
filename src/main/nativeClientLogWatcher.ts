import { createRequire } from 'node:module';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { isClientLogFile } from './clientLogPaths';

// Keep types local: this optional, darwin-only dependency is absent on Windows.
export interface NativeClientLogEvents {
  constants: Record<'MustScanSubDirs' | 'UserDropped' | 'KernelDropped' | 'EventIdsWrapped' | 'RootChanged' | 'Mount' | 'Unmount' | 'ItemIsDir' | 'ItemCreated' | 'ItemRemoved' | 'ItemRenamed', number>;
  watch(dir: string, callback: (file: string, flags: number) => void): () => Promise<void>;
}

export function loadNativeClientLogEvents(): NativeClientLogEvents | null {
  if (process.platform !== 'darwin') return null;
  return createRequire(import.meta.url)('fsevents') as NativeClientLogEvents;
}

/** Watch the nearest existing parent so missing/replaced roots remain discoverable. */
export async function watchNativeClientLogs(
  native: NativeClientLogEvents, parent: string, dir: string,
  dirty: (file: string) => void, reconcile: () => void,
): Promise<() => Promise<void>> {
  const canonical = await realpath(parent);
  const c = native.constants;
  const rescan = c.MustScanSubDirs | c.UserDropped | c.KernelDropped | c.EventIdsWrapped | c.RootChanged | c.Mount | c.Unmount;
  let closed = false;
  // FSEvents does not traverse a symlinked log root; keep its parent watch for replacement too.
  const roots = [{ physical: canonical, logical: parent }];
  try {
    const target = await realpath(dir);
    if (target !== path.resolve(canonical, path.relative(parent, dir))) roots.push({ physical: target, logical: dir });
  } catch (e) {
    if (!['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
  }
  const stops: (() => Promise<void>)[] = [];
  const receive = (physical: string, logicalRoot: string, file: string, flags: number) => {
    if (closed) return;
    // Loss may be reported for the stream/volume, outside the client subtree.
    if (!file || (flags & rescan)) { reconcile(); return; }
    const relative = path.relative(physical, file);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
    const logical = path.resolve(logicalRoot, relative);
    if (logical === dir || dir.startsWith(`${logical}${path.sep}`)) { reconcile(); return; }
    if (!logical.startsWith(`${dir}${path.sep}`)) return;
    if (flags & c.ItemIsDir) {
      if (flags & (c.ItemCreated | c.ItemRemoved | c.ItemRenamed)) dirty(logical);
    } else if (isClientLogFile(logical)) dirty(logical);
  };
  try {
    for (const root of roots) stops.push(native.watch(root.physical, (file, flags) => receive(root.physical, root.logical, file, flags)));
  } catch (e) {
    closed = true;
    await Promise.allSettled(stops.map((stop) => stop()));
    throw e;
  }
  return async () => { closed = true; await Promise.all(stops.map((stop) => stop())); };
}
