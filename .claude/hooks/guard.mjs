#!/usr/bin/env node
// PreToolUse guard: keeps worktrees from sharing or wiping another checkout's node_modules.
// stdin: PreToolUse JSON. exit 0 allows; exit 2 blocks with the reason on stderr. Fails open on any internal error.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';

/** Bounds the walk up to a repository root. */
const ROOT_SEARCH_DEPTH = 12;
const PROCESS_SCAN_TIMEOUT_MS = 5000;

/** One spelling per path: lowercase, forward slashes, Git Bash and WSL mounts as drive letters. */
function normalizePath(p) {
  const s = (p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const wsl = s.match(/^\/mnt\/([a-z])(?=\/|$)/);
  if (wsl) return `${wsl[1]}:${s.slice(wsl[0].length)}`;
  const gitBash = s.match(/^\/([a-z])(?=\/|$)/);
  if (gitBash) return `${gitBash[1]}:${s.slice(gitBash[0].length)}`;
  return s;
}

/** A path in the form this process can open. */
function toFsPath(p) {
  const drive = normalizePath(p).match(/^([a-z]):(.*)$/);
  if (!drive) return p;
  return process.platform === 'win32' ? `${drive[1]}:${drive[2]}` : `/mnt/${drive[1]}${drive[2]}`;
}

/** Removes quoted text and heredoc bodies so a commit message, echo or PR body cannot trip a verb match. */
function stripLiterals(cmd) {
  return cmd.replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1(?=\s|$)/g, ' ').replace(/@'[\s\S]*?'@/g, ' ').replace(/@"[\s\S]*?"@/g, ' ').replace(/'[^']*'/g, ' ').replace(/"[^"]*"/g, ' ');
}

/** The command's last absolute cd / Set-Location / -C / --dir hop, else cwd. Quotes are dropped, not their contents. */
function effectiveDir(rawCmd, cwd) {
  const c = rawCmd.replace(/["']/g, '');
  const hops = [...c.matchAll(/(?:^|[\s;&|])(?:cd|pushd|set-location|sl|--prefix|--dir|-C)\s+((?:[a-z]:|\/)[^\s;&|]+)/gi)];
  return hops.length > 0 ? hops[hops.length - 1][1] : cwd;
}

function isLink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

const parentOf = (p) => { const up = p.replace(/[\\/][^\\/]*$/, ''); return up === p ? null : up; };

/** A linked node_modules at dir, an ancestor up to the repo root, or a child package. Junctions read as links. */
function linkedNodeModules(dir) {
  const fsDir = toFsPath(dir || '').replace(/[\\/]+$/, '');
  if (!fsDir) return null;
  let up = fsDir;
  for (let i = 0; i < ROOT_SEARCH_DEPTH && up; i++) {
    if (isLink(`${up}/node_modules`)) return `${up}/node_modules`;
    if (existsSync(`${up}/.git`)) break;
    up = parentOf(up);
  }
  try {
    for (const name of readdirSync(fsDir)) {
      if (name !== 'node_modules' && isLink(`${fsDir}/${name}/node_modules`)) return `${fsDir}/${name}/node_modules`;
    }
  } catch { /* unreadable: nothing found */ }
  return null;
}

/**
 * The main checkout dir is inside, read from git's own marker: a .git folder in the main checkout,
 * a .git file naming <main>/.git/worktrees/<name> in a worktree. Null outside a repository.
 */
function mainCheckoutOf(dir) {
  let up = toFsPath(dir || '').replace(/[\\/]+$/, '');
  for (let i = 0; i < ROOT_SEARCH_DEPTH && up; i++) {
    const marker = `${up}/.git`;
    if (existsSync(marker)) {
      if (statSync(marker).isDirectory()) return { root: normalizePath(up), isMain: true };
      const gitdir = (readFileSync(marker, 'utf8').match(/^gitdir:\s*(.+)$/m) || [])[1];
      const main = gitdir ? normalizePath(gitdir.trim()).split('/.git/worktrees/')[0] : null;
      return main ? { root: main, isMain: false } : null;
    }
    up = parentOf(up);
  }
  return null;
}

/** Is an Electron process running from root? GUARD_PROCESS_PATHS (newline-separated) stands in for the process list in tests. */
function electronRunningFrom(root) {
  let paths = process.env.GUARD_PROCESS_PATHS;
  if (paths === undefined) {
    const shell = process.platform === 'win32' ? 'powershell' : 'powershell.exe';
    const r = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', 'Get-Process electron -ErrorAction SilentlyContinue | ForEach-Object Path'],
      { encoding: 'utf8', timeout: PROCESS_SCAN_TIMEOUT_MS });
    paths = r.stdout ?? '';
  }
  return paths.split(/\r?\n/).some((p) => p.trim() && normalizePath(p.trim()).startsWith(`${root}/`));
}

/** pnpm/npm/yarn/bun subcommands that relink, rebuild or delete node_modules. */
const INSTALL_LIKE = /\b(pnpm|npm|yarn|bun)\s+(?:--?[\w-]+(?:[= ]\S+)?\s+)*(install|i|ci|add|remove|rm|uninstall|update|up|upgrade|prune|rebuild|dedupe|link|unlink|import|reinstall)\b/i;
const PACKAGE_MANAGER = /(?:^|[\s;&|])(pnpm|npm|yarn|bun)(?:\.cmd)?(?=\s|$)/i;
const DELETES = /(?:^|[\s;&|])(rm|Remove-Item|rmdir|rd|del)\s/i;
const DELETE_NODE_MODULES = /(?:^|[\s;&|])(rm|Remove-Item|rmdir|rd|del)\s[^;&|]*node_modules/i;
/** This repository's cleanup command. */
const CLEANUP = 'node scripts/remove-worktree.mts';

function check(rawCmd, cwd) {
  const flat = rawCmd.replace(/\s+/g, ' ');
  const verbs = stripLiterals(rawCmd).replace(/\s+/g, ' ');

  // A package-manager run through a shared link rewrites the other checkout's links; deleting this one strands them.
  if (/node_modules/i.test(flat) &&
      (/-ItemType\s+(Junction|SymbolicLink|HardLink)/i.test(verbs) || /\bmklink\b/i.test(verbs) || /\bln\s+-\w*s/i.test(verbs))) {
    return `BLOCKED — never link node_modules between checkouts. A package-manager run through the link rewrites the other checkout's links, and deleting this one strands them.
Run \`pnpm install --frozen-lockfile\` in the worktree; pnpm hard-links from its store, so it takes seconds.`;
  }

  const dir = effectiveDir(rawCmd, cwd);
  if (PACKAGE_MANAGER.test(verbs)) {
    const linked = linkedNodeModules(dir);
    if (linked) {
      return `BLOCKED — ${linked} is a link to another checkout's packages; a package-manager run here would rewrite that checkout's links.
Delete just the link (\`cmd /c rmdir <link>\`, never a recursive delete), then \`pnpm install --frozen-lockfile\` here.`;
    }
  }

  const repo = mainCheckoutOf(dir);
  if (repo?.isMain) {
    if (/confirmModulesPurge/i.test(verbs) || (DELETES.test(verbs) && DELETE_NODE_MODULES.test(flat))) {
      return `BLOCKED — never purge or delete node_modules in the main checkout; the user's app runs from it.
Fix a broken link with a plain \`pnpm install --frozen-lockfile\`, or ask.`;
    }
    if (INSTALL_LIKE.test(verbs) && electronRunningFrom(repo.root)) {
      return `BLOCKED — Electron is running from the main checkout. An install can decide to wipe node_modules, stop at the locked electron.exe, and leave packages half deleted.
Ask the user to close the app first.`;
    }
  }

  if (/\bgit\s+(-C\s+\S+\s+)?worktree\s+remove\b/i.test(verbs)) {
    return `BLOCKED — use the link-safe cleanup instead of 'git worktree remove'.
${CLEANUP} <path> --delete-branch   (add --orphan for a leftover folder git no longer tracks)`;
  }
  return null;
}

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let deny = null;
  try {
    const input = JSON.parse(raw || '{}');
    const command = input.tool_input?.command;
    if ((input.tool_name === 'Bash' || input.tool_name === 'PowerShell') && typeof command === 'string') {
      deny = check(command, input.cwd);
    }
  } catch {
    deny = null;
  }
  if (deny) {
    process.stderr.write(deny + '\n');
    process.exit(2);
  }
  process.exit(0);
});
