import { spawnSync } from 'node:child_process';
import { app } from 'electron';
import type { HourCycle } from '@shared/timeFormat';

/** Windows short time pattern: `H` is 24-hour, `h` is 12-hour (Region → Short time). */
export function windowsHourCycle(pattern: string): HourCycle {
  return pattern.includes('H') ? 'h23' : pattern.includes('h') ? 'h12' : null;
}

/** A locale's default clock (`en_GB.UTF-8` or `en-GB`); C/POSIX formats times with `%H`, so 24-hour. */
export function localeHourCycle(locale: string | undefined): HourCycle {
  const tag = locale?.split(/[.@]/)[0]?.replace(/_/g, '-');
  if (!tag) return null;
  if (tag === 'C' || tag === 'POSIX') return 'h23';
  try {
    const cycle = new Intl.DateTimeFormat(tag, { hour: 'numeric' }).resolvedOptions().hourCycle;
    return cycle === 'h11' || cycle === 'h12' ? 'h12' : cycle ? 'h23' : null;
  } catch { return null; }
}

/** macOS: the Date & Time "24-hour time" toggle when set, else the region's default. */
export function macHourCycle(readDefault: (key: string) => string | null, regionLocale: () => string): HourCycle {
  if (readDefault('AppleICUForce24HourTime') === '1') return 'h23';
  if (readDefault('AppleICUForce12HourTime') === '1') return 'h12';
  if (readDefault('AppleICUForce24HourTime') === '0') return 'h12';
  return localeHourCycle(regionLocale());
}

type Gsettings = (schema: string, key: string) => string | null;
// Desktops whose clock follows org.gnome.desktop.interface clock-format.
const GNOME_CLOCK_DESKTOPS = /gnome|unity|ubuntu|budgie|pantheon|pop|cosmic/i;
/** Linux: the GNOME or Cinnamon clock setting, else LC_TIME (KDE Plasma exports its Formats choice there). */
export function linuxHourCycle(env: NodeJS.ProcessEnv, gsettings: Gsettings): HourCycle {
  const desktop = env.XDG_CURRENT_DESKTOP ?? '';
  if (/cinnamon/i.test(desktop)) {
    const use24 = gsettings('org.cinnamon.desktop.interface', 'clock-use-24h');
    if (use24 === 'true' || use24 === 'false') return use24 === 'true' ? 'h23' : 'h12';
  }
  if (GNOME_CLOCK_DESKTOPS.test(desktop)) {
    const format = gsettings('org.gnome.desktop.interface', 'clock-format')?.replace(/'/g, '');
    if (format === '24h' || format === '12h') return format === '24h' ? 'h23' : 'h12';
  }
  return localeHourCycle(env.LC_ALL || env.LC_TIME || env.LANG);
}

const run = (command: string, args: string[]): string | null => {
  const out = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  return out.status === 0 ? out.stdout.trim() : null;
};

/** This OS's clock setting; `systemLocale` is called only when no explicit setting decides. */
export function readHourCycle(systemLocale: () => string): HourCycle {
  if (process.platform === 'win32') {
    const pattern = /sShortTime\s+REG_SZ\s+(.+)/.exec(run('reg', ['query', String.raw`HKCU\Control Panel\International`, '/v', 'sShortTime']) ?? '')?.[1]?.trim();
    return pattern ? windowsHourCycle(pattern) : localeHourCycle(systemLocale());
  }
  if (process.platform === 'darwin') return macHourCycle((key) => run('defaults', ['read', '-g', key]), systemLocale);
  return linuxHourCycle(process.env, (schema, key) => run('gsettings', ['get', schema, key]));
}

let cached: HourCycle | undefined;
/** The OS clock preference, read once per launch. Throws before app ready on every OS: Electron's system locale needs it. */
export function systemHourCycle(): HourCycle {
  if (!app.isReady()) throw new Error('systemHourCycle() called before app ready');
  return cached === undefined ? cached = readHourCycle(() => app.getSystemLocale()) : cached;
}
