import os from 'node:os';
import path from 'node:path';
import type { ClientId } from '@shared/types';
/** Home folder per client, honouring the overrides each client reads (CLAUDE_CONFIG_DIR, CODEX_HOME). */
export function clientHomes(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): Record<ClientId, string> {
  return { claude: env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), codex: env.CODEX_HOME || path.join(home, '.codex') };
}
