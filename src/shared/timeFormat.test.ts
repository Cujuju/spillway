import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { appLocale, parseHourCycle, setHourCycle } from './timeFormat';
import { linuxHourCycle, localeHourCycle, macHourCycle, systemHourCycle, windowsHourCycle } from '../main/hourCycle';

afterEach(() => setHourCycle(null));
const AFTERNOON = new Date(2026, 0, 1, 15, 5);

it('formats times with the system hour cycle', () => {
  setHourCycle('h23'); expect(AFTERNOON.toLocaleTimeString(appLocale(), { hour: 'numeric', minute: '2-digit' })).toMatch(/^15:05$/);
  setHourCycle('h12'); expect(AFTERNOON.toLocaleTimeString(appLocale(), { hour: 'numeric', minute: '2-digit' })).toMatch(/3:05\s?PM/i);
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
  expect(macHourCycle(defaults({ AppleICUForce24HourTime: '1' }), 'en-US')).toBe('h23');
  expect(macHourCycle(defaults({ AppleICUForce12HourTime: '1' }), 'en-DE')).toBe('h12');
  expect(macHourCycle(defaults({ AppleICUForce24HourTime: '0' }), 'en-DE')).toBe('h12');
  expect([macHourCycle(defaults({}), 'en-DE'), macHourCycle(defaults({}), 'en-US')]).toEqual(['h23', 'h12']);
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
  expect(systemHourCycle()).not.toBeNull();
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
