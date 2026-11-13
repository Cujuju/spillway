import { spawnSync } from 'node:child_process';
import { systemPreferences } from 'electron';
import type { HourCycle } from '@shared/timeFormat';

/** Windows short time pattern: `H` is 24-hour, `h` is 12-hour (Region → Short time). */
export function windowsHourCycle(pattern: string): HourCycle {
  return pattern.includes('H') ? 'h23' : pattern.includes('h') ? 'h12' : null;
}

let cached: HourCycle | undefined;
/** The OS clock preference, read once per launch; Linux has no system-wide setting beyond the locale, which Intl already applies. */
export function systemHourCycle(): HourCycle { return cached === undefined ? cached = readHourCycle() : cached; }

function readHourCycle(): HourCycle {
  if (process.platform === 'win32') {
    const out = spawnSync('reg', ['query', String.raw`HKCU\Control Panel\International`, '/v', 'sShortTime'], { encoding: 'utf8', windowsHide: true });
    const pattern = /sShortTime\s+REG_SZ\s+(.+)/.exec(out.stdout ?? '')?.[1]?.trim();
    return pattern ? windowsHourCycle(pattern) : null;
  }
  if (process.platform === 'darwin') {
    if (systemPreferences.getUserDefault('AppleICUForce24HourTime', 'boolean')) return 'h23';
    if (systemPreferences.getUserDefault('AppleICUForce12HourTime', 'boolean')) return 'h12';
  }
  return null;
}
