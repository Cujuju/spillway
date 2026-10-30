import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { ActivityRpc, ACTIVITY_QUEUE_CAP, ACTIVITY_RESTART_BACKOFF_MS, type RpcPort } from './activityRpc';
import type { Request } from './activityProtocol';
class Port extends EventEmitter implements RpcPort {
  sent: Request[] = [];
  postMessage(request: Request): void { this.sent.push(request); }
  reply(value?: unknown, error?: string): void { this.emit('message', { id: this.sent.at(-1)!.id, value, error }); }
}
afterEach(() => vi.useRealTimers());
it('serializes requests and propagates errors without blocking later calls', async () => {
  const port = new Port();
  const rpc = new ActivityRpc(() => port);
  rpc.start();
  const first = rpc.call('days');
  const failure = rpc.call('coverage');
  const rejected = expect(failure).rejects.toThrow('query failed');
  const last = rpc.call('totalsList');
  expect(port.sent.map((r) => r.method)).toEqual(['days']);
  port.reply(['today']);
  expect(await first).toEqual(['today']);
  port.reply(undefined, 'query failed');
  await rejected;
  port.reply([]);
  expect(await last).toEqual([]);
  expect(port.sent.map((r) => r.method)).toEqual(['days', 'coverage', 'totalsList']);
});
it('replays only the unacknowledged head after a crash, then drains before close', async () => {
  vi.useFakeTimers();
  const ports: Port[] = [];
  const rpc = new ActivityRpc(() => { const port = new Port(); ports.push(port); return port; });
  const failed = vi.fn();
  rpc.on('failure', failed);
  rpc.start();
  const first = rpc.call('prune');
  const second = rpc.call('days');
  ports[0]!.emit('error', new Error('crash'));
  ports[0]!.emit('exit', 1);
  await vi.advanceTimersByTimeAsync(ACTIVITY_RESTART_BACKOFF_MS);
  expect(failed).toHaveBeenCalledTimes(1);
  expect(ports[1]!.sent[0]).toEqual(ports[0]!.sent[0]);
  ports[1]!.reply();
  await first;
  const closing = rpc.close();
  expect(ports[1]!.sent.at(-1)!.method).toBe('days');
  ports[1]!.reply([]);
  await second;
  expect(ports[1]!.sent.at(-1)!.method).toBe('close');
  ports[1]!.reply();
  await closing;
  ports[1]!.emit('exit', 0);
  await vi.advanceTimersByTimeAsync(ACTIVITY_RESTART_BACKOFF_MS);
  expect(ports).toHaveLength(2);
  await expect(rpc.call('days')).rejects.toThrow('closed');
});

it('retains a failed proxy write for retry ahead of queries and shutdown', async () => {
  vi.useFakeTimers();
  const port = new Port();
  const rpc = new ActivityRpc(() => port);
  rpc.start();
  const failure = vi.fn();
  rpc.on('failure', failure);
  const write = rpc.call('append', {} as import('@shared/types').ActivityEvent);
  const close = rpc.close();
  port.reply(undefined, 'disk temporarily unavailable');
  expect(failure).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(ACTIVITY_RESTART_BACKOFF_MS);
  expect(port.sent.map((r) => r.method)).toEqual(['append', 'append']);
  expect(port.sent[0]).toEqual(port.sent[1]);
  port.reply({ id: 1 });
  await write;
  expect(port.sent.at(-1)!.method).toBe('close');
  port.reply();
  await close;
});

it('bounds outages, drops the oldest append, and reports the cumulative loss', async () => {
  const port = new Port();
  const rpc = new ActivityRpc(() => port);
  const failure = vi.fn();
  rpc.on('failure', failure);
  const writes = Array.from({ length: 4_002 }, (_, i) =>
    rpc.call('append', { requestId: String(i) } as import('@shared/types').ActivityEvent).catch(() => null));
  expect(rpc.droppedEvents).toBe(2);
  expect(failure.mock.lastCall?.[0]).toContain('2');
  expect(await writes[0]).toBeNull();
  expect(ACTIVITY_QUEUE_CAP).toBe(4_000);
  rpc.start();
  expect(port.sent[0]).toMatchObject({ args: [{ requestId: '2' }] });
  const progress = vi.fn();
  rpc.on('progress', progress);
  port.emit('message', { event: 'progress', value: { state: 'idle', error: null } });
  expect(progress.mock.lastCall?.[0].error).toContain('2 unacknowledged events dropped');
  rpc.cancel();
  await Promise.all(writes);
});

it('does not move an overflowing backlog into a stalled worker port', async () => {
  const port = new Port();
  const rpc = new ActivityRpc(() => port);
  rpc.start();
  const writes = Array.from({ length: ACTIVITY_QUEUE_CAP + 3 }, (_, i) =>
    rpc.call('append', { requestId: String(i) } as import('@shared/types').ActivityEvent).catch(() => null));
  expect(port.sent).toHaveLength(1);
  port.reply({ id: 1 });
  expect(port.sent).toHaveLength(2);
  expect(port.sent[1]).toMatchObject({ args: [{ requestId: '3' }] });
  rpc.cancel();
  await Promise.all(writes);
});
