// Codex's key command entry. Callers that are Electron apps (T3 Code) pass ELECTRON_RUN_AS_NODE=1 down,
// which turns Spillway into plain Node and crashes it. Re-run Spillway without it, forwarding the arguments.
const { spawnSync } = require('node:child_process');

const EXIT_FAILED = 1;

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const result = spawnSync(process.execPath, process.argv.slice(2), { env, stdio: 'inherit', windowsHide: true });
if (result.error) process.stderr.write(`${result.error.message}\n`);
process.exit(result.status ?? EXIT_FAILED);
