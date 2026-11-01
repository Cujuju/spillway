/** Fake proxy: answers the app's management API calls with fixtures.mts data. Shapes follow docs/desktop-api.md in the fork; anything else is 404. */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ACCOUNTS, usageWindows, type DemoData } from './fixtures.mts';

const MANAGEMENT_PREFIX = '/v8/management';
/** Shown as the proxy version on the sidebar card, so screenshots never claim a real release. */
const DEMO_VERSION = 'demo';
/** SSE comment cadence; keeps the stream from looking idle to proxies or timeouts. */
const KEEPALIVE_MS = 15_000;
const LOOPBACK = '127.0.0.1';
/** Replay pace (500 requests/s): the app stores them faster, so its 4,000-entry queue (ACTIVITY_QUEUE_CAP) never fills. */
const REPLAY_BATCH = 250;
const REPLAY_PAUSE_MS = 500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface DemoProxy {
  endpoint: string;
  /** Request events the stream replays to its first reader. */
  eventCount: number;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let text = '';
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => {
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const json = (res: ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'X-CPA-VERSION': DEMO_VERSION });
  res.end(JSON.stringify(body));
};

export async function startDemoProxy(data: DemoData): Promise<DemoProxy> {
  const preferred = new Map<string, string>();
  const usage = () => usageWindows(data, preferred);
  let replayed = false;
  const streams = new Set<ServerResponse>();

  function events(res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('event: ready\ndata: {}\n\n');
    streams.add(res);
    res.on('close', () => streams.delete(res));
    // Replayed once: the app stores what it reads, so a reconnect must not add the same requests again.
    if (!replayed) void replay(res);
    replayed = true;
  }

  async function replay(res: ServerResponse): Promise<void> {
    for (let i = 0; i < data.events.length && streams.has(res); i += REPLAY_BATCH) {
      res.write(data.events.slice(i, i + REPLAY_BATCH).map((e) => `event: request\ndata: ${JSON.stringify(e)}\n\n`).join(''));
      await sleep(REPLAY_PAUSE_MS);
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${LOOPBACK}`);
    const path = url.pathname.startsWith(MANAGEMENT_PREFIX) ? url.pathname.slice(MANAGEMENT_PREFIX.length) : null;
    const route = `${req.method} ${path}`;
    switch (route) {
      case 'GET /config/routing/strategy': return json(res, { strategy: 'soonest-reset' });
      case 'GET /usage/windows':
      case 'POST /usage/refresh': return json(res, usage());
      case 'GET /usage/events': return events(res);
      case 'POST /usage/reset-credit': return json(res, { code: 'nothing_to_reset', windows_reset: 0, usage: usage() });
      case 'POST /usage/start-window': return json(res, { usage: usage() });
      case 'GET /routing/preferred-auth':
      case 'PUT /routing/preferred-auth': {
        if (req.method === 'PUT') {
          const body = await readBody(req);
          if (typeof body.provider === 'string' && typeof body.auth_index === 'string') {
            if (body.auth_index) preferred.set(body.provider, body.auth_index);
            else preferred.delete(body.provider);
          }
        }
        return json(res, { preferred: Object.fromEntries(preferred) });
      }
      case 'POST /routing/move-session': return json(res, { bound: 1 });
      case 'GET /server/lockouts': return json(res, { lockouts: [] });
      case 'DELETE /server/lockouts':
      case 'POST /server/shutdown':
      case 'PATCH /credentials/status':
      case 'PATCH /credentials/fields': return json(res, {});
      case 'POST /credentials/refresh': return json(res, { results: ACCOUNTS.filter((a) => !a.apiKey).map((a) => ({ id: a.id, success: true })) });
      case 'GET /credentials/models': {
        const account = ACCOUNTS.find((a) => a.id === url.searchParams.get('name'));
        return json(res, { models: (account?.models ?? []).map((id) => ({ id, owned_by: account?.provider })) });
      }
      default: return json(res, { error: `demo proxy: ${route} not implemented` }, 404);
    }
  }

  const server = createServer((req, res) => void route(req, res));
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK, resolve));
  const keepalive = setInterval(() => streams.forEach((s) => s.write(': keepalive\n\n')), KEEPALIVE_MS);
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://${LOOPBACK}:${port}`,
    eventCount: data.events.length,
    close: () => {
      clearInterval(keepalive);
      streams.forEach((s) => s.end());
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
