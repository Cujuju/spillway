import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { APP_ID } from '@shared/app';
import { desktopExec, setLinuxLoginItem } from './linuxLoginItem';

it('writes and updates an XDG autostart entry and removes only its own file', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'spillway-autostart-'));
  try {
    const file = path.join(dir, 'autostart', `${APP_ID}.desktop`);
    setLinuxLoginItem(true, true, '/home/me/Spillway App.AppImage', dir);
    expect(readFileSync(file, 'utf8')).toContain('Exec="/home/me/Spillway App.AppImage" --hidden\n');
    const other = path.join(dir, 'autostart', 'other.desktop');
    writeFileSync(other, 'other');
    setLinuxLoginItem(true, false, '/home/me/new.AppImage', dir);
    expect(readFileSync(file, 'utf8')).toContain('Exec="/home/me/new.AppImage"\n');
    setLinuxLoginItem(false, false, '/unused', dir);
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(other, 'utf8')).toBe('other');
    setLinuxLoginItem(false, false, '/unused', dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('escapes Exec field codes and shell metacharacters without accepting new entries', () => {
  expect(desktopExec('/home/me/a%"$`\\.AppImage')).toBe('"/home/me/a%%\\\\"\\\\$\\\\`\\\\\\\\.AppImage"');
  expect(() => desktopExec('/tmp/app\nHidden=true')).toThrow('Invalid autostart');
});
