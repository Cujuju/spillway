import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { appLocale, parseHourCycle, setHourCycle } from './timeFormat';
import { windowsHourCycle } from '../main/hourCycle';

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

const SRC = path.join(import.meta.dirname, '..');
const sources = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const file = path.join(dir, name);
  return statSync(file).isDirectory() ? sources(file) : /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [file] : [];
});
it('formats every date and time through appLocale(), so none ignores the OS clock setting', () => {
  // A fixed string-literal locale is a deliberate exception (machine-stable number text).
  const offenders = sources(SRC).flatMap((file) => readFileSync(file, 'utf8').split('\n').flatMap((line, i) =>
    /(toLocale(Date|Time)?String|Intl\.DateTimeFormat)\((?!appLocale\(\)|'[^']*')/.test(line) && !file.endsWith('timeFormat.ts') ? [`${path.relative(SRC, file)}:${i + 1}`] : []));
  expect(offenders).toEqual([]);
});
