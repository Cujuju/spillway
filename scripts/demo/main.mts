/** `pnpm demo [theme]` opens the app on fake data until you quit it; `pnpm demo --screenshots` captures docs/images and quits. */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchDemo } from './launch.mts';
import { capture } from './screenshots.mts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCREENSHOTS_FLAG = '--screenshots';

const args = process.argv.slice(2);
if (args.includes(SCREENSHOTS_FLAG)) {
  for (const file of await capture()) console.log(path.relative(ROOT, file));
} else {
  const app = await launchDemo({ theme: args.find((a) => !a.startsWith('--')) });
  console.log(`demo: fake proxy at ${app.proxy.endpoint}, ${app.proxy.eventCount} requests`);
  await app.exited;
  await app.close();
}
