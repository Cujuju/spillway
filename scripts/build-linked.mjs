// Builds every `link:` dependency (the local solidjs-toolkit packages) for CI and packaging,
// whose bundles import their gitignored dist/. Typecheck reads src/ via `cujuju-source`;
// tests via `cujuju-source` too; the renderer via `solid`. Never run it on a shared toolkit checkout: it restarts apps using it.
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
