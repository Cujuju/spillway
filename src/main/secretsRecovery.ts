import { dialog } from 'electron';
import { APP_NAME } from '@shared/app';
import type { SecretsRecovery } from './settingsStore';

const STORE_NAMES: Partial<Record<NodeJS.Platform, string>> = { darwin: 'the macOS Keychain', win32: 'Windows data protection' };
const BUTTONS = ['Try again', 'Reset keys', 'Quit'] as const;

/** Asks before replacing keys the OS store can't unlock right now (locked keyring, denied Keychain prompt). */
export const promptSecretsRecovery: SecretsRecovery = async (error) => {
  const store = STORE_NAMES[process.platform] ?? 'the system keyring';
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: APP_NAME,
    message: `${APP_NAME} can't unlock its saved keys`,
    detail: `${store} didn't decrypt them (${error instanceof Error ? error.message : String(error)}). `
      + 'Unlock it and try again. Reset makes new keys: clients set up with the old key need setting up again, '
      + 'and Activity history starts over. The old files stay beside the new ones.',
    buttons: [...BUTTONS],
    defaultId: BUTTONS.indexOf('Try again'),
    cancelId: BUTTONS.indexOf('Quit'),
    noLink: true,
  });
  return BUTTONS[response] === 'Try again' ? 'retry' : BUTTONS[response] === 'Reset keys' ? 'reset' : 'quit';
};
