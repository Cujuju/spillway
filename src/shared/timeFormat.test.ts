import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { appLocale, dateTimeFormat, DEFAULT_TIME_OPTIONS, numberFormat, parseHourCycle, setHourCycle } from './timeFormat';
import { linuxHourCycle, localeHourCycle, macHourCycle, readHourCycle, windowsHourCycle } from '../main/hourCycle';

afterEach(() => {
  vi.restoreAllMocks();
  setHourCycle(null);
});
const AFTERNOON = new Date(2026, 0, 1, 15, 5);
const TIME_OPTIONS = { hour: 'numeric', minute: '2-digit' } as const;
const DATE_OPTIONS = { weekday: 'short', month: 'short', day: 'numeric' } as const;
const NUMBER_OPTIONS = { style: 'currency', currency: 'USD', maximumFractionDigits: 3 } as const;

it('formats times with the system hour cycle', () => {
  setHourCycle('h23');
  expect(dateTimeFormat(TIME_OPTIONS).format(AFTERNOON)).toMatch(/^15:05$/);
  setHourCycle('h12');
  expect(dateTimeFormat(TIME_OPTIONS).format(AFTERNOON)).toMatch(/3:05\s?PM/i);
});

it('reuses the base locale across calls and hour-cycle changes', () => {
  const base = new Intl.DateTimeFormat().resolvedOptions().locale;
  expect(appLocale()).toBe(base);
  const constructor = vi.spyOn(Intl, 'DateTimeFormat');

  for (const cycle of ['h23', 'h12', null] as const) {
    setHourCycle(cycle);
    const expected = cycle ? `${base}-u-hc-${cycle}` : base;
    expect(appLocale()).toBe(expected);
    expect(appLocale()).toBe(expected);
  }
  expect(constructor).not.toHaveBeenCalled();
});

it('shares formatters across reordered options, reads inherited options, ignores unknown keys, and bounds cache size', () => {
  expect(dateTimeFormat(TIME_OPTIONS)).toBe(dateTimeFormat({ minute: '2-digit', second: undefined, hour: 'numeric' }));
  expect(numberFormat(NUMBER_OPTIONS)).toBe(numberFormat({ maximumFractionDigits: 3, minimumFractionDigits: undefined, currency: 'USD', style: 'currency' }));
  expect(dateTimeFormat()).toBe(dateTimeFormat({ hour: undefined }));
  expect(numberFormat()).toBe(numberFormat({ style: undefined }));
  expect(dateTimeFormat(TIME_OPTIONS)).not.toBe(dateTimeFormat(DATE_OPTIONS));
  expect(numberFormat(NUMBER_OPTIONS)).not.toBe(numberFormat({ currency: 'EUR', style: 'currency', maximumFractionDigits: 3 }));

  // Inherited option properties must match explicit ones instead of colliding with {}.
  const inheritedDate = Object.create({ hour: 'numeric' }) as Intl.DateTimeFormatOptions;
  expect(dateTimeFormat(inheritedDate)).toBe(dateTimeFormat({ hour: 'numeric' }));
  expect(dateTimeFormat(inheritedDate)).not.toBe(dateTimeFormat({}));

  // Unknown properties ignored by Intl must not split cache entries.
  const extraA = { hour: 'numeric', extra: 1 } as Intl.DateTimeFormatOptions;
  const extraB = { hour: 'numeric', extra: 2 } as Intl.DateTimeFormatOptions;
  expect(dateTimeFormat(extraA)).toBe(dateTimeFormat(extraB));

  // Stateful option getters are read once and cannot poison the cache with a mismatched formatter.
  let reads = 0;
  const stateful: Intl.NumberFormatOptions = {
    get maximumFractionDigits() { return reads++ === 0 ? 2 : 0; },
  };
  expect(numberFormat(stateful).format(1.25)).toBe('1.25');
  expect(numberFormat({ maximumFractionDigits: 2 }).format(1.25)).toBe('1.25');
  expect(reads).toBe(1);

  // Cache stays bounded: inserting >64 distinct valid entries evicts the oldest one.
  const first = numberFormat({ maximumFractionDigits: 0 });
  for (let d = 1; d <= 70; d++) numberFormat({ maximumFractionDigits: d });
  expect(numberFormat({ maximumFractionDigits: 0 })).not.toBe(first);
});

it('matches default toLocaleTimeString across 12-hour and 24-hour locales and hour cycles', () => {
  const sample = new Date(2026, 0, 1, 1, 5, 3);
  for (const tag of ['en-GB', 'en-GB-u-hc-h23', 'en-GB-u-hc-h12', 'de-DE', 'en-US', 'en-US-u-hc-h23']) {
    expect(new Intl.DateTimeFormat(tag, DEFAULT_TIME_OPTIONS).format(sample)).toBe(sample.toLocaleTimeString(tag));
  }
  for (const cycle of ['h23', 'h12', null] as const) {
    setHourCycle(cycle);
    expect(dateTimeFormat(DEFAULT_TIME_OPTIONS).format(sample)).toBe(sample.toLocaleTimeString(appLocale()));
  }
});

it('invalidates cached date formatters when the effective time zone changes, even without process.env', () => {
  const opts = { hour: 'numeric', minute: '2-digit' } as const;
  const realProcess = globalThis.process;
  try {
    vi.stubEnv('TZ', 'Africa/Cairo');
    vi.stubGlobal('process', undefined);
    setHourCycle('h23');
    const octInstant = new Date('2026-10-25T12:00:00Z');
    const cairoFmt = dateTimeFormat(opts);
    expect(cairoFmt.format(octInstant)).toBe(octInstant.toLocaleTimeString(appLocale(), opts));
    // Cairo and Beirut share Jan/Jul offsets and summer name, differing on late-October DST end.
    realProcess.env.TZ = 'Asia/Beirut';
    const beirutFmt = dateTimeFormat(opts);
    expect(beirutFmt).not.toBe(cairoFmt);
    expect(beirutFmt.format(octInstant)).toBe(octInstant.toLocaleTimeString(appLocale(), opts));
    expect(beirutFmt.format(octInstant)).not.toBe(cairoFmt.format(octInstant));
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

it('invalidates both formatter caches on each hour-cycle change', () => {
  let time = dateTimeFormat(TIME_OPTIONS);
  let number = numberFormat(NUMBER_OPTIONS);
  for (const cycle of ['h23', 'h12', null] as const) {
    setHourCycle(cycle);
    const nextTime = dateTimeFormat(TIME_OPTIONS);
    const nextNumber = numberFormat(NUMBER_OPTIONS);
    expect(nextTime).not.toBe(time);
    expect(nextNumber).not.toBe(number);
    time = nextTime;
    number = nextNumber;
  }
});

it.each(['h23', 'h12', null] as const)('matches native locale formatting with hour cycle %s', (cycle) => {
  setHourCycle(cycle);
  const locale = appLocale();
  const dateAndTime = { ...DATE_OPTIONS, ...TIME_OPTIONS };
  expect(dateTimeFormat(TIME_OPTIONS).format(AFTERNOON)).toBe(AFTERNOON.toLocaleTimeString(locale, TIME_OPTIONS));
  expect(dateTimeFormat(DATE_OPTIONS).format(AFTERNOON.getTime())).toBe(AFTERNOON.toLocaleDateString(locale, DATE_OPTIONS));
  expect(dateTimeFormat(dateAndTime).format(AFTERNOON)).toBe(AFTERNOON.toLocaleString(locale, dateAndTime));
  expect(numberFormat(NUMBER_OPTIONS).format(1234.567)).toBe((1234.567).toLocaleString(locale, NUMBER_OPTIONS));
});

it('reads the Windows short time pattern and rejects unknown cycles', () => {
  expect([windowsHourCycle('HH:mm'), windowsHourCycle('h:mm tt'), windowsHourCycle('mm')]).toEqual(['h23', 'h12', null]);
  expect([parseHourCycle('h23'), parseHourCycle('h24'), parseHourCycle(undefined)]).toEqual(['h23', null, null]);
});

it('falls back to the locale default, reading POSIX names and C as 24-hour', () => {
  expect([localeHourCycle('en_GB.UTF-8'), localeHourCycle('en_US.UTF-8'), localeHourCycle('de-DE'), localeHourCycle('C'), localeHourCycle(''), localeHourCycle(undefined)]).toEqual(['h23', 'h12', 'h23', 'h23', null, null]);
});

it('reads the macOS toggle, else the region default', () => {
  const defaults = (values: Record<string, string>) => (key: string) => values[key] ?? null;
  // An explicit toggle decides without the region, so the ready-only locale getter is never called.
  const unread = () => { throw new Error('region read'); };
  expect(macHourCycle(defaults({ AppleICUForce24HourTime: '1' }), unread)).toBe('h23');
  expect(macHourCycle(defaults({ AppleICUForce12HourTime: '1' }), unread)).toBe('h12');
  expect(macHourCycle(defaults({ AppleICUForce24HourTime: '0' }), unread)).toBe('h12');
  expect([macHourCycle(defaults({}), () => 'en-DE'), macHourCycle(defaults({}), () => 'en-US')]).toEqual(['h23', 'h12']);
});

it('reads the GNOME or Cinnamon clock, else LC_TIME, ignoring GNOME settings on other desktops', () => {
  const gsettings = (values: Record<string, string>) => (schema: string, key: string) => values[`${schema} ${key}`] ?? null;
  const gnome24 = gsettings({ 'org.gnome.desktop.interface clock-format': "'24h'" });
  expect(linuxHourCycle({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME', LANG: 'en_US.UTF-8' }, gnome24)).toBe('h23');
  expect(linuxHourCycle({ XDG_CURRENT_DESKTOP: 'X-Cinnamon', LANG: 'en_GB.UTF-8' }, gsettings({ 'org.cinnamon.desktop.interface clock-use-24h': 'false' }))).toBe('h12');
  expect(linuxHourCycle({ XDG_CURRENT_DESKTOP: 'KDE', LANG: 'en_US.UTF-8', LC_TIME: 'en_GB.UTF-8' }, gnome24)).toBe('h23');
  expect(linuxHourCycle({ XDG_CURRENT_DESKTOP: 'KDE', LANG: 'en_US.UTF-8' }, gnome24)).toBe('h12');
  expect(linuxHourCycle({ XDG_CURRENT_DESKTOP: 'GNOME', LC_ALL: 'de_DE.UTF-8', LANG: 'en_US.UTF-8' }, gsettings({}))).toBe('h23');
});

// Every Windows profile has a short time pattern, so a null here means the registry read failed.
it.runIf(process.platform === 'win32')('reads the hour cycle from the Windows registry', () => {
  expect(readHourCycle(() => { throw new Error('locale fallback used'); })).not.toBeNull();
});

// Runs the real `defaults` reads; a 12/24-hour toggle or the fixed region always decides.
it.runIf(process.platform === 'darwin')('reads the clock with the native macOS tools', () => {
  expect(['h23', 'h12']).toContain(readHourCycle(() => 'en-US'));
});

const SRC = path.join(import.meta.dirname, '..');
const sources = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const file = path.join(dir, name);
  return statSync(file).isDirectory() ? sources(file) : /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [file] : [];
});
it('formats every date and time through appLocale(), so none ignores the OS clock setting', () => {
  // Exceptions: fixed string-literal locales (machine-stable number text); hourCycle.ts reads locale defaults, never formats.
  const offenders = sources(SRC).flatMap((file) => readFileSync(file, 'utf8').split('\n').flatMap((line, i) =>
    /(toLocale(Date|Time)?String|Intl\.DateTimeFormat)\((?!appLocale\(\)|'[^']*')/.test(line) && !/(timeFormat|hourCycle)\.ts$/.test(file) ? [`${path.relative(SRC, file)}:${i + 1}`] : []));
  expect(offenders).toEqual([]);
});
