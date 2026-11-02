import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP_ID, APP_NAME } from '@shared/app';

export const HIDDEN_ARG = '--hidden';

/** Desktop Entry strings escape backslashes before the Exec field's quoted-argument escaping. */
export function desktopExec(executable: string): string {
  if (/[\r\n\0]/.test(executable)) throw new Error('Invalid autostart executable path');
  const quoted = executable.replace(/[\\`"$]/g, '\\$&').replace(/\\/g, '\\\\').replace(/%/g, '%%');
  return `"${quoted}"`;
}

/** AppImage mounts are temporary; autostart must point at the original AppImage. */
export function setLinuxLoginItem(enabled: boolean, hidden: boolean, executable = process.env.APPIMAGE ?? process.execPath,
  configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')): void {
  const file = path.join(configHome, 'autostart', `${APP_ID}.desktop`);
  if (!enabled) {
    rmSync(file, { force: true });
    return;
  }
  const exec = `${desktopExec(executable)}${hidden ? ` ${HIDDEN_ARG}` : ''}`;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `[Desktop Entry]\nType=Application\nName=${APP_NAME}\nExec=${exec}\nTerminal=false\n`, { mode: 0o600 });
}
