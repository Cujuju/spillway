// Rebuilds every `link:` dependency (the local solidjs-toolkit packages) before a typecheck.
// Their `types` export is the gitignored dist/, so without this tsc reads whatever was last built.
// Runtime and tests read their src/ through the `solid` export condition and need no build.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LINK_PREFIX = 'link:';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const deps = { ...pkg.dependencies, ...pkg.devDependencies };

for (const [name, spec] of Object.entries(deps)) {
  if (typeof spec !== 'string' || !spec.startsWith(LINK_PREFIX)) continue;
  const dir = path.resolve(root, spec.slice(LINK_PREFIX.length));
  console.log(`build-linked: ${name}`);
  // A fixed command string: `pnpm` is a .cmd shim on Windows, which needs a shell.
  execSync('pnpm run build', { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] });
}
