// Rebuilds each stale `link:` dependency (the local solidjs-toolkit packages) before a typecheck.
// Their `types` export is the gitignored dist/, so without this tsc reads whatever was last built.
// Runtime and tests read their src/ through the `solid` export condition and need no build.
// Only stale packages rebuild: the toolkit checkout is shared, and rewriting its dist/ restarts
// every other app running from it (their dev servers watch the linked dist/).
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LINK_PREFIX = 'link:';
const BUILD_OUTPUT_DIR = 'dist';
/** Not build inputs: outputs, installed packages, tests and docs. */
const IGNORED_DIRS = new Set([BUILD_OUTPUT_DIR, 'node_modules', '__tests__']);
const IGNORED_EXTENSIONS = new Set(['.md']);
/** The toolkit's build config shared by every package (tsconfig base, Vite lib config). */
const SHARED_CONFIG_DIR = path.join('..', '_shared');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const deps = { ...pkg.dependencies, ...pkg.devDependencies };

/** Modification times (ms) of every file under `dir`, skipping ignored dirs and extensions. */
function fileTimes(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return IGNORED_DIRS.has(entry.name) ? [] : fileTimes(full);
    return IGNORED_EXTENSIONS.has(path.extname(entry.name)) ? [] : [statSync(full).mtimeMs];
  });
}

/** Stale when dist/ is missing or empty, or any input changed after its oldest output was written. */
function isStale(dir) {
  const outDir = path.join(dir, BUILD_OUTPUT_DIR);
  if (!existsSync(outDir)) return true;
  const outputs = readdirSync(outDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => statSync(path.join(entry.parentPath, entry.name)).mtimeMs);
  if (outputs.length === 0) return true;
  const sharedDir = path.resolve(dir, SHARED_CONFIG_DIR);
  const inputs = [...fileTimes(dir), ...(existsSync(sharedDir) ? fileTimes(sharedDir) : [])];
  return Math.max(...inputs) > Math.min(...outputs);
}

for (const [name, spec] of Object.entries(deps)) {
  if (typeof spec !== 'string' || !spec.startsWith(LINK_PREFIX)) continue;
  const dir = path.resolve(root, spec.slice(LINK_PREFIX.length));
  if (!isStale(dir)) {
    console.log(`build-linked: ${name} up to date`);
    continue;
  }
  console.log(`build-linked: ${name}`);
  // A fixed command string: `pnpm` is a .cmd shim on Windows, which needs a shell.
  execSync('pnpm run build', { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] });
}
