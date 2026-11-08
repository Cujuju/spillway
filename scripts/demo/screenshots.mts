/** `pnpm demo --screenshots`: captures the demo app into docs/images/<page>-<scheme>.png over the DevTools Protocol. See docs/setup.md. */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp, freePort, sleep, until } from './cdp.mts';
import { DARK_THEME, DEMO_WINDOW, launchDemo } from './launch.mts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const IMAGES_DIR = path.join(ROOT, 'docs', 'images');
/** The demo window's size at 1x, whatever the display scaling, so images stay small in git history. */
const VIEWPORT = { ...DEMO_WINDOW, deviceScaleFactor: 1, mobile: false };
const PAGES = ['Dashboard', 'Activity', 'Providers'];
/** Every demo account must show here without scrolling. */
const FIT_PAGE = 'Dashboard';
/** Pixels hidden below the fold in the page's scroll areas. */
const OVERFLOW_JS = `Math.max(0, ...[...document.querySelectorAll('*')].filter((e) => /auto|scroll/.test(getComputedStyle(e).overflowY)).map((e) => e.scrollHeight - e.clientHeight))`;
const THEMES = [{ scheme: 'dark', theme: DARK_THEME }, { scheme: 'light', theme: 'light' }];
/** Charts and lists finish drawing well inside this after a page or theme change. */
const SETTLE_MS = 2_000;

const open = (cdp: Cdp, page: string) => cdp.eval(`document.querySelector('button.nav-btn[aria-label=${JSON.stringify(page)}]').click()`);

async function capture(): Promise<string[]> {
  const port = await freePort();
  const app = await launchDemo({ debuggingPort: port });
  const written: string[] = [];
  try {
    const cdp = await Cdp.mainWindow(port);
    await cdp.send('Emulation.setDeviceMetricsOverride', VIEWPORT);
    await until('account usage', () => cdp.eval<boolean>('window.api.usageLatest().then((u) => u.snapshot !== null)').then((ok) => ok || null));
    await until('stored requests', () =>
      cdp.eval<number>('window.api.activityTotals().then((t) => t.reduce((n, r) => n + r.requests, 0))').then((n) => (n >= app.proxy.eventCount ? n : null)));
    await open(cdp, FIT_PAGE);
    await sleep(SETTLE_MS);
    const overflow = await cdp.eval<number>(OVERFLOW_JS);
    if (overflow > 0) throw new Error(`${FIT_PAGE} overflows the demo window by ${overflow}px; raise DEMO_WINDOW.height in scripts/demo/launch.mts`);
    mkdirSync(IMAGES_DIR, { recursive: true });
    for (const { scheme, theme } of THEMES) {
      await cdp.eval(`window.api.getSettings().then((s) => window.api.setSettings({ ...s, general: { ...s.general, theme: ${JSON.stringify(theme)} } }))`);
      for (const page of PAGES) {
        await open(cdp, page);
        await sleep(SETTLE_MS);
        // A resized Activity board can be taller than any window; grow the viewport so the whole page shows.
        const below = await cdp.eval<number>(OVERFLOW_JS);
        if (below > 0) {
          await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, height: VIEWPORT.height + below });
          await sleep(SETTLE_MS);
        }
        const { data } = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
        if (below > 0) await cdp.send('Emulation.setDeviceMetricsOverride', VIEWPORT);
        const file = path.join(IMAGES_DIR, `${page.toLowerCase()}-${scheme}.png`);
        writeFileSync(file, Buffer.from(data, 'base64'));
        written.push(file);
      }
    }
    cdp.close();
  } finally {
    await app.close();
  }
  return written;
}

export { capture };
