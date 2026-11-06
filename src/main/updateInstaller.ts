import { powerMonitor } from 'electron';
import { MINUTES_PER_HOUR } from '@shared/windowStartSettings';
import { getSettings, onSettingsChange } from './settingsStore';
import { updates } from './updater';

/** Next local occurrence strictly after now; local setters follow daylight saving changes. */
export function nextInstallAt(minute: number, now: Date): number {
  const next = new Date(now);
  next.setHours(Math.floor(minute / MINUTES_PER_HOUR), minute % MINUTES_PER_HOUR, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
    next.setHours(Math.floor(minute / MINUTES_PER_HOUR), minute % MINUTES_PER_HOUR, 0, 0);
  }
  return next.getTime();
}

/** Applies ready updates according to the current install mode. */
export function startUpdateInstaller(): void {
  let timer: NodeJS.Timeout | null = null;
  let target: number | null = null;

  const clear = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const arm = (): void => {
    clear();
    if (target === null) return;
    if (target <= Date.now()) updates.quitAndInstall();
    else timer = setTimeout(() => updates.quitAndInstall(), target - Date.now());
  };
  const sync = (): void => {
    clear();
    target = null;
    if (updates.status().state !== 'ready') return;
    const { autoInstall, installMinute } = getSettings().updates;
    if (autoInstall === 'now') updates.quitAndInstall();
    if (autoInstall === 'scheduled') {
      target = nextInstallAt(installMinute, new Date());
      arm();
    }
  };

  updates.on('status', sync);
  onSettingsChange((next, prev) => {
    if (next.updates.autoInstall === prev.updates.autoInstall && next.updates.installMinute === prev.updates.installMinute) return;
    sync();
    if (prev.updates.autoInstall === 'off' && next.updates.autoInstall !== 'off' && updates.status().state === 'available') void updates.download();
  });
  powerMonitor.on('resume', arm);
  sync();
}
