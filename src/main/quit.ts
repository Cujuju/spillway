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
  // Electron starts the new instance once this one has exited, after the proxy stops (before-quit).
  if (relaunch) app.relaunch();
  app.quit();
}
