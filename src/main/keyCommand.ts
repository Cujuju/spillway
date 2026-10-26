/**
 * Print-key mode: `Spillway --print-client-key` prints the client key and exits.
 * Codex runs it as its provider auth command, so the key never sits in config.toml.
 */
import { app } from 'electron';
import type { KeyCommand } from './clientConfigText';
import { readClientKey } from './settingsStore';

export const PRINT_CLIENT_KEY_ARG = '--print-client-key';

const EXIT_OK = 0;
const EXIT_FAILED = 1;

export const isPrintClientKeyLaunch = () => process.argv.includes(PRINT_CLIENT_KEY_ARG);

/** The command clients run to fetch the key. Dev runs Electron with the app folder as its first argument. */
export function clientKeyCommand(): KeyCommand {
  const args = app.isPackaged ? [PRINT_CLIENT_KEY_ARG] : [app.getAppPath(), PRINT_CLIENT_KEY_ARG];
  return { command: process.execPath, args };
}

/**
 * Reads the key without starting the app: no window, tray, proxy or single-instance lock.
 * Electron on Windows prints a leading CRLF to piped stdout; Codex trims the output.
 */
export function runPrintClientKey(): void {
  app.dock?.hide();
  void app
    .whenReady()
    .then(readClientKey)
    .then((key) => process.stdout.write(key, () => app.exit(EXIT_OK)))
    .catch((err: unknown) => {
      process.stderr.write(`${(err as Error).message}\n`, () => app.exit(EXIT_FAILED));
    });
}
