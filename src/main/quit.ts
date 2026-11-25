import { spawn } from 'node:child_process';
import path from 'node:path';
import { app, dialog } from 'electron';
import { APP_NAME } from '@shared/app';
import { takeQuitReason } from './quitReason';
import { getSettings } from './settingsStore';

const CONFIRM_BUTTON = 0;
/** One confirmation at a time: a second Quit while it is open does nothing. */
let confirming = false;

/** Quits the app, or restarts it with `relaunch`, asking first when the user enabled quit confirmation. */
export async function requestQuit({ relaunch = false, confirmed = false } = {}): Promise<void> {
  if (!confirmed && getSettings().general.confirmQuit) {
    if (confirming) return;
    confirming = true;
    const verb = relaunch ? 'Restart' : 'Quit';
    // A Dock Quit can arrive while another app is in front; the dialog must be seen to be answered.
    if (process.platform === 'darwin') app.focus({ steal: true });
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
    }).finally(() => { confirming = false; });
    if (r.response !== CONFIRM_BUTTON) return;
  }
  if (relaunch) {
    // Restart after the proxy stops (before-quit), letting the toolkit finish a staged update first.
    if (app.isPackaged) {
      const { installsOnQuit, updates } = await import('./updater');
      if (installsOnQuit() && updates.status().state === 'ready') updates.installOnQuit(true);
      else app.relaunch(process.platform === 'linux' && process.env.APPIMAGE ? { execPath: process.env.APPIMAGE } : {});
    }
    else if (app.commandLine.hasSwitch('user-data-dir')) app.relaunch();
    else relaunchDev();
  }
  app.quit();
}

/** macOS Dock Quit (or a script's quit) arrives as before-quit; true when it should ask first. Logout, restart and shutdown never ask. */
export function confirmsSystemQuit(): boolean {
  return takeQuitReason() === 'quit' && getSettings().general.confirmQuit;
}

/** `pnpm dev` exits with the dev app, so a detached launcher reruns it once this app exits; that also rebuilds the proxy. */
function relaunchDev(): void {
  const root = app.getAppPath();
  const child = process.platform === 'win32'
    // The Start Menu launcher, told to wait for this app and its `pnpm dev` to exit first.
    ? spawn('conhost.exe', [
        '--headless', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(root, 'scripts', 'dev-launch.ps1'),
        '-Name', 'SpillwayDev', '-TaskName', 'SpillwayDev',
        '-MutexName', 'Local\\SpillwayDevLauncher', '-LogName', 'spillway-dev-shortcut.log',
        '-SingleInstance', '-HideElectronShortcut', '-DefaultEnv', 'REMOTE_DEBUGGING_PORT=9333',
        '-AfterExit',
      ], { cwd: root, detached: true, stdio: 'ignore' })
    // Unix launchers wait for this process before restarting the dev app.
    : spawn(process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh', ['-l', '-c', `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done; unset ELECTRON_RUN_AS_NODE; export REMOTE_DEBUGGING_PORT="\${REMOTE_DEBUGGING_PORT:-9333}"; exec pnpm dev >"\${TMPDIR:-/tmp}/spillway-dev.log" 2>&1`], { cwd: root, detached: true, stdio: 'ignore' });
  child.unref();
}
