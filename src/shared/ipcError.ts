/** Electron wraps a failed `invoke` as `Error invoking remote method '<channel>': Error: <message>`. */
const REMOTE_PREFIX = /^Error invoking remote method '[^']*': (?:Error: )?/;

/** The main process's own message, without Electron's invoke wrapper. */
export function remoteMessage(message: string): string {
  return message.replace(REMOTE_PREFIX, '');
}

/** Rethrows an `invoke` failure as an Error carrying the main-process message. */
export function unwrapRemoteError(error: unknown): never {
  if (error instanceof Error) {
    error.message = remoteMessage(error.message);
    throw error;
  }
  throw new Error(remoteMessage(String(error)));
}
