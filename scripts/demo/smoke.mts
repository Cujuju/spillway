/** `pnpm smoke`: boots the built app on a throwaway profile and the fake proxy, opens every page, and fails on a crash, a missing window or an uncaught renderer error. */

import { Cdp, freePort, sleep, until } from './cdp.mts';
import { launchDemo } from './launch.mts';

/** Long enough for a page's first fetch to settle and throw if it is going to. */
const PAGE_SETTLE_MS = 1_000;
const NAV_LABELS_JS = `[...document.querySelectorAll('button.nav-btn[aria-label]')].map((b) => b.getAttribute('aria-label'))`;

interface ExceptionThrown { exceptionDetails: { text: string; exception?: { description?: string } } }

export async function smoke(): Promise<string[]> {
  const port = await freePort();
  const app = await launchDemo({ debuggingPort: port });
  const exited = () => (app.child.exitCode === null && app.child.signalCode === null ? null : `the app exited (${app.child.exitCode ?? app.child.signalCode})`);
  try {
    const cdp = await Cdp.mainWindow(port, exited);
    const errors: string[] = [];
    cdp.on<ExceptionThrown>('Runtime.exceptionThrown', ({ exceptionDetails: d }) => errors.push(d.exception?.description ?? d.text));
    // A renderer crash throws nothing in the page; Inspector reports it.
    cdp.on('Inspector.targetCrashed', () => errors.push('the renderer crashed'));
    await cdp.send('Inspector.enable');
    await cdp.send('Runtime.enable');
    const pages = await until('the page navigation', () => cdp.eval<string[]>(NAV_LABELS_JS).then((labels) => (labels.length ? labels : null)), exited);
    await until('account usage from the proxy', () => cdp.eval<boolean>('window.api.usageLatest().then((u) => u.snapshot !== null)').then((ok) => ok || null), exited);
    for (const page of pages) {
      await cdp.eval(`document.querySelector('button.nav-btn[aria-label=${JSON.stringify(page)}]').click()`);
      await sleep(PAGE_SETTLE_MS);
    }
    cdp.close();
    const crash = exited();
    if (crash) throw new Error(crash);
    if (errors.length) throw new Error(`renderer failures:\n${errors.join('\n')}`);
    return pages;
  } finally {
    await app.close();
  }
}
