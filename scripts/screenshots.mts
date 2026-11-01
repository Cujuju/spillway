/** `pnpm screenshots`: captures the app on fake data (scripts/demo) into docs/images/<page>-<scheme>.png over the DevTools Protocol. See docs/setup.md. */

import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchDemo } from './demo/launch.mts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const IMAGES_DIR = path.join(ROOT, 'docs', 'images');
/** The app's default window size (window.ts), at 1x so images stay small in git history. Height then grows to fit FIT_PAGE. */
const VIEWPORT = { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false };
const PAGES = ['Dashboard', 'Activity', 'Providers'];
/** Every demo account must show here, so all shots take its full height. */
const FIT_PAGE = 'Dashboard';
/** Layout settles after one resize; more passes only guard against content that reflows. */
const MAX_FIT_PASSES = 3;
/** Pixels hidden below the fold in the page's scroll areas. */
const OVERFLOW_JS = `Math.max(0, ...[...document.querySelectorAll('*')].filter((e) => /auto|scroll/.test(getComputedStyle(e).overflowY)).map((e) => e.scrollHeight - e.clientHeight))`;
const THEMES = [{ scheme: 'dark', theme: 'dracula' }, { scheme: 'light', theme: 'light' }];
/** Charts and lists finish drawing well inside this after a page or theme change. */
const SETTLE_MS = 2_000;
const POLL_MS = 250;
/** Startup plus storing a few thousand replayed requests; a minute is several times what it takes. */
const READY_TIMEOUT_MS = 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const open = (cdp: Cdp, page: string) => cdp.eval(`document.querySelector('button.nav-btn[aria-label=${JSON.stringify(page)}]').click()`);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function until<T>(what: string, probe: () => Promise<T | null | undefined>): Promise<T> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = await probe().catch(() => null);
    if (value !== null && value !== undefined) return value;
    await sleep(POLL_MS);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Minimal CDP client for one page target. */
class Cdp {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private ws: WebSocket;
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (m) => {
      const msg = JSON.parse(String(m.data)) as { id?: number; result?: unknown; error?: { message: string } };
      const call = msg.id === undefined ? undefined : this.pending.get(msg.id);
      if (!call) return;
      this.pending.delete(msg.id!);
      if (msg.error) call.reject(new Error(msg.error.message));
      else call.resolve(msg.result);
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    return new Cdp(ws);
  }

  send<T = unknown>(method: string, params: object = {}): Promise<T> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject }));
  }

  /** Runs an expression in the page, awaiting promises; returns its JSON value. */
  async eval<T>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value: T }; exceptionDetails?: { text: string } }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }

  close(): void {
    this.ws.close();
  }
}

async function capture(): Promise<string[]> {
  const port = await freePort();
  const app = await launchDemo({ debuggingPort: port });
  const written: string[] = [];
  try {
    const target = await until('the app window', async () => {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
      return list.find((t) => t.type === 'page' && t.url.includes('index.html'));
    });
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send('Emulation.setDeviceMetricsOverride', VIEWPORT);
    await until('account usage', () => cdp.eval<boolean>('window.api.usageLatest().then((u) => u.snapshot !== null)').then((ok) => ok || null));
    await until('stored requests', () =>
      cdp.eval<number>('window.api.activityTotals().then((t) => t.reduce((n, r) => n + r.requests, 0))').then((n) => (n >= app.proxy.eventCount ? n : null)));
    await open(cdp, FIT_PAGE);
    let height = VIEWPORT.height;
    for (let pass = 0; pass < MAX_FIT_PASSES; pass++) {
      await sleep(SETTLE_MS);
      const overflow = await cdp.eval<number>(OVERFLOW_JS);
      if (overflow <= 0) break;
      height += overflow;
      await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, height });
    }
    mkdirSync(IMAGES_DIR, { recursive: true });
    for (const { scheme, theme } of THEMES) {
      await cdp.eval(`window.api.getSettings().then((s) => window.api.setSettings({ ...s, general: { ...s.general, theme: ${JSON.stringify(theme)} } }))`);
      for (const page of PAGES) {
        await open(cdp, page);
        await sleep(SETTLE_MS);
        const { data } = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const file of await capture()) console.log(path.relative(ROOT, file));
}

export { capture };
