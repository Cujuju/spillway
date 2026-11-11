/** Fake proxy: answers the app's management API calls with fixtures.mts data. Shapes follow docs/desktop-api.md in the fork; anything else is 404. */

import { CANARY_PROBES } from '../../src/shared/canary.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CAPTURE_BODY_LIMIT } from '../../src/shared/archive.ts';
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
const DEMO_HISTORY_TURNS = 96;
const DEMO_TURN_TEXT = 'Captured exchanges keep the original protocol body for local inspection. ';
const DEMO_TURN_REPEATS = Math.ceil(CAPTURE_BODY_LIMIT / DEMO_HISTORY_TURNS / Buffer.byteLength(DEMO_TURN_TEXT));

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
  let captureEnabled = false;
  const captureEpoch = 'demo-capture-epoch';
  const demoTrace = (id: string) => `demo-inbound-${id}`;
  const demoCapture = () => {
    const e = data.events.at(-1)!;
    const model = 'claude-sonnet-4-6';
    const request = JSON.stringify({ model, max_tokens: 1024,
      system: 'Help inspect the local request archive. Explain what was captured and what was truncated.',
      tools: [{ name: 'inspect_archive', description: 'Read local archive totals.', input_schema: { type: 'object', properties: { scope: { type: 'string' } } } }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Inspect the request archive for alex@example.com.' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'I will check the captured exchanges.' }, { type: 'tool_use', id: 'tool_demo_1', name: 'inspect_archive', input: { scope: 'today' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_demo_1', content: '12 exchanges captured; 2 request bodies reached the recording limit.' }] },
        ...Array.from({ length: DEMO_HISTORY_TURNS }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `Earlier conversation turn ${index + 1}: ` + DEMO_TURN_TEXT.repeat(DEMO_TURN_REPEATS) }] })),
        { role: 'user', content: 'Summarize the large and truncated exchanges.' },
      ],
    });
    return { id: 'demo-capture-1', traceId: demoTrace(e.request_id), epoch: captureEpoch, sequence: 1, startedAt: e.at,
      method: 'POST', path: '/v1/messages', status: 200, state: 'partial', reason: 'byte-limit',
      request: request.slice(0, CAPTURE_BODY_LIMIT / 2) + request.slice(-CAPTURE_BODY_LIMIT / 2),
      requestCut: { offset: CAPTURE_BODY_LIMIT / 2, omitted: Buffer.byteLength(request) - CAPTURE_BODY_LIMIT }, responseCut: null,
      response: JSON.stringify({ id: 'msg_demo_1', type: 'message', role: 'assistant', model,
        content: [{ type: 'text', text: 'The archive contains 12 exchanges. Large request bodies retain their head and tail around an omitted middle.' }, { type: 'tool_use', id: 'tool_demo_2', name: 'inspect_archive', input: { scope: 'truncated' } }],
        stop_reason: 'tool_use', usage: { input_tokens: 70000, output_tokens: 80 } }),
      requestType: 'application/json', responseType: 'application/json', requestEncoding: '', responseEncoding: '' };
  };
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
      res.write(data.events.slice(i, i + REPLAY_BATCH).map((e) => `event: request\ndata: ${JSON.stringify({ ...e, cache_creation_1h_tokens: 0, cache_creation_long_tokens: 0, tier: 'standard', trace_id: demoTrace(e.request_id) })}\n\n`).join(''));
      await sleep(REPLAY_PAUSE_MS);
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'POST' && ['/v1/messages', '/v1/chat/completions'].includes(req.url ?? '')) {
      const body = await readBody(req), messages = body.messages as { content: string }[];
      const probe = CANARY_PROBES.find((p) => p.prompt === messages?.[0]?.content);
      const answer = `ANSWER: ${probe?.id === 'seats' ? 'B' : probe?.answer ?? 'unknown'}`;
      json(res, req.url === '/v1/messages' ? { model: body.model, content: [{ type: 'text', text: answer }], usage: { output_tokens: 120, output_tokens_details: { thinking_tokens: 100 } } } : { model: body.model, choices: [{ message: { content: answer } }], usage: { completion_tokens: 120, completion_tokens_details: { reasoning_tokens: 100 } } });
      return;
    }
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
      case 'PUT /observability/captures/lease': {
        captureEnabled = (await readBody(req)).enabled === true;
        return json(res, { leaseSeconds: 60, bodyLimit: CAPTURE_BODY_LIMIT });
      }
      case 'GET /observability/captures': return json(res, { version: 1, epoch: captureEpoch, dropped: 0, records: captureEnabled && data.events.length && Number(url.searchParams.get('after') ?? 0) < 1 ? [demoCapture()] : [] });
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
