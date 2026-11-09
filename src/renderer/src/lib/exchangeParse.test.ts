import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExchangeInput, ExchangeSides, parseExchange as parse } from './exchangeParse';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<{ id: number; sides: ExchangeSides }>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn<(message: { id: number; detail: ExchangeInput }) => void>();
  terminate = vi.fn();

  constructor() { FakeWorker.instances.push(this); }
  reply(id: number, sides: ExchangeSides): void {
    this.onmessage?.({ data: { id, sides } } as MessageEvent<{ id: number; sides: ExchangeSides }>);
  }
}

const detail: ExchangeInput = { request: '{}', response: '{}', frames: [], format: 'http', reason: '' };
const sides = (raw: string): ExchangeSides => ({
  request: { raw, pretty: null, messages: null, cut: false },
  response: { raw, pretty: null, messages: null, cut: false },
});
let parseExchange: typeof parse;

beforeEach(async () => {
  vi.resetModules();
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
  ({ parseExchange } = await import('./exchangeParse'));
});
afterEach(() => vi.unstubAllGlobals());

it('shares one lazy worker, posts only input fields, and correlates replies by id', async () => {
  expect(FakeWorker.instances).toHaveLength(0);
  const withAttempts = { ...detail, attempts: ['not sent'] };
  const first = parseExchange(withAttempts, new AbortController().signal);
  const second = parseExchange(detail, new AbortController().signal);
  expect(FakeWorker.instances).toHaveLength(1);
  const worker = FakeWorker.instances[0]!;
  expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith({ id: expect.any(Number), detail });
  const firstId = worker.postMessage.mock.calls[0]![0].id;
  let settled = false;
  void first.then(() => { settled = true; });
  worker.reply(firstId + 1, sides('unmatched'));
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  worker.reply(firstId, sides('first'));
  await expect(first).resolves.toEqual(sides('first'));
  expect(worker.postMessage).toHaveBeenCalledTimes(2);
  const secondId = worker.postMessage.mock.calls[1]![0].id;
  expect(secondId).not.toBe(firstId);
  worker.reply(firstId, sides('duplicate'));
  worker.reply(secondId, sides('second'));
  await expect(second).resolves.toEqual(sides('second'));
});

it('never posts calls aborted before posting, including queued calls', async () => {
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await expect(parseExchange(detail, alreadyAborted.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(FakeWorker.instances).toHaveLength(0);
  const first = parseExchange(detail, new AbortController().signal);
  const queued = new AbortController();
  const dropped = parseExchange(detail, queued.signal);
  queued.abort();
  await expect(dropped).rejects.toBeInstanceOf(DOMException);
  await expect(dropped).rejects.toMatchObject({ name: 'AbortError' });
  const last = parseExchange(detail, new AbortController().signal);
  const worker = FakeWorker.instances[0]!;
  worker.reply(worker.postMessage.mock.calls[0]![0].id, sides('first'));
  await expect(first).resolves.toEqual(sides('first'));
  expect(worker.postMessage).toHaveBeenCalledTimes(2);
  worker.reply(worker.postMessage.mock.calls[1]![0].id, sides('last'));
  await expect(last).resolves.toEqual(sides('last'));
});

it('rejects an active abort immediately and discards its late reply without cancelling another caller', async () => {
  const controller = new AbortController();
  const aborted = parseExchange(detail, controller.signal);
  const next = parseExchange(detail, new AbortController().signal);
  const worker = FakeWorker.instances[0]!;
  controller.abort();
  await expect(aborted).rejects.toBeInstanceOf(DOMException);
  await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
  expect(worker.terminate).not.toHaveBeenCalled();
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  worker.reply(worker.postMessage.mock.calls[0]![0].id, sides('aborted'));
  expect(worker.postMessage).toHaveBeenCalledTimes(2);
  worker.reply(worker.postMessage.mock.calls[1]![0].id, sides('next'));
  await expect(next).resolves.toEqual(sides('next'));
});

it('rejects active and queued calls on a worker error and recreates the worker for the next call', async () => {
  const first = parseExchange(detail, new AbortController().signal);
  const queued = parseExchange(detail, new AbortController().signal);
  const worker = FakeWorker.instances[0]!;
  worker.onerror?.({ message: 'worker crashed' } as ErrorEvent);
  await expect(first).rejects.toBeInstanceOf(Error);
  await expect(first).rejects.toThrow('worker crashed');
  await expect(queued).rejects.toBeInstanceOf(Error);
  await expect(queued).rejects.toThrow('worker crashed');
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  const recovered = parseExchange(detail, new AbortController().signal);
  expect(FakeWorker.instances).toHaveLength(2);
  const replacement = FakeWorker.instances[1]!;
  replacement.reply(replacement.postMessage.mock.calls[0]![0].id, sides('recovered'));
  await expect(recovered).resolves.toEqual(sides('recovered'));
});
