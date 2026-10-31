// Enables the tracked hooks in .githooks (pnpm install runs this through `prepare`).
// A global core.hooksPath (this machine's word-policy hooks) forwards to hooks.repoHooksPath; otherwise point git there directly.
import { execFileSync } from 'node:child_process';

const git = (args) => { try { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
if (git(['rev-parse', '--git-dir'])) {
  git(['config', git(['config', '--global', '--get', 'core.hooksPath']) ? 'hooks.repoHooksPath' : 'core.hooksPath', '.githooks']);
}
