import { app, dialog } from 'electron';
import { getSettings } from './settingsStore';

const QUIT_BUTTON = 0;

/** Quits the app, asking first when the user enabled quit confirmation. */
export async function requestQuit(): Promise<void> {
  if (getSettings().general.confirmQuit) {
    const r = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Quit', 'Cancel'],
      defaultId: QUIT_BUTTON,
      cancelId: 1,
      title: 'Quit CLIProxy Desktop',
      message: 'Quit CLIProxy Desktop?',
      detail: 'The proxy stops too, so Claude Code and other clients lose their connection.',
    });
    if (r.response !== QUIT_BUTTON) return;
  }
  app.quit();
}
