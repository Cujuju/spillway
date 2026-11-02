import { spawn } from 'node:child_process';
import path from 'node:path';
import { app, dialog } from 'electron';
import { APP_NAME } from '@shared/app';
import { getSettings } from './settingsStore';

const CONFIRM_BUTTON = 0;

/** Quits the app, or restarts it with `relaunch`, asking first when the user enabled quit confirmation. */
export async function requestQuit({ relaunch = false } = {}): Promise<void> {
  if (getSettings().general.confirmQuit) {
    const verb = relaunch ? 'Restart' : 'Quit';
    const r = await dialog.showMessageBox({
      type: 'question',
      buttons: [verb, 'Cancel'],
      defaultId: CONFIRM_BUTTON,
      cancelId: 1,
      title: `${verb} ${APP_NAME}`,
      message: `${verb} ${APP_NAME}?`,
      detail: relaunch
        ? 'The proxy restarts too, so Claude Code and other clients lose their connection briefly.'
        : 'The proxy stops too, so Claude Code and other clients lose their connection.',
    });
    if (r.response !== CONFIRM_BUTTON) return;
  }
  if (relaunch) {
    // Electron starts the new instance once this one has exited, after the proxy stops (before-quit).
    if (app.isPackaged) app.relaunch(process.platform === 'linux' && process.env.APPIMAGE ? { execPath: process.env.APPIMAGE } : {});
    else relaunchDev();
  }
  app.quit();
}

/** `pnpm dev` exits with the dev app, so a detached launcher reruns it once this app exits; that also rebuilds the proxy. */
function relaunchDev(): void {
  const root = app.getAppPath();
  const child = process.platform === 'win32'
    // The Start Menu launcher, told to wait for this app and its `pnpm dev` to exit first.
    ? spawn('conhost.exe', ['--headless', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'dev-launch.ps1'), '-AfterExit'], { cwd: root, detached: true, stdio: 'ignore' })
    // Unix launchers wait for this process before restarting the dev app.
    : spawn(process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh', ['-l', '-c', `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done; unset ELECTRON_RUN_AS_NODE; exec pnpm dev >"\${TMPDIR:-/tmp}/spillway-dev.log" 2>&1`], { cwd: root, detached: true, stdio: 'ignore' });
  child.unref();
}
