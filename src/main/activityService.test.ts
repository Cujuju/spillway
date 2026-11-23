import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { ActivityRpc, type RpcPort } from './activityRpc';
import type { Request } from './activityProtocol';
import { ActivityRouter } from './activityRouter';

class MockPort extends EventEmitter implements RpcPort {
  sent: Request[] = [];
  terminated = false;
  postMessage(request: Request): void { this.sent.push(request); }
  reply(value?: unknown, error?: string): void { this.emit('message', { id: this.sent.at(-1)!.id, value, error }); }
  terminate(): void { this.terminated = true; }
}

function createHarness() {
  const writerPort = new MockPort();
  const namesPort = new MockPort();
  const readerPorts: MockPort[] = [];
  const writer = new ActivityRpc(() => writerPort);
  const names = new ActivityRpc(() => namesPort);
  const router = new ActivityRouter(writer, () => {
    const port = new MockPort();
    readerPorts.push(port);
    return new ActivityRpc(() => port);
  }, names);
  return { router, writerPort, namesPort, readerPorts };
}

describe('ActivityRouter', () => {
  it('routes names to the names worker, reads to the reader after reset, and writes to the writer', async () => {
    const { router, writerPort, namesPort, readerPorts } = createHarness();
    router.start();

    // Before the writer emits its first reset, reads go to the writer so the DB schema exists first.
    const beforeReset = router.call('days');
    expect(writerPort.sent.at(-1)?.method).toBe('days');
    expect(readerPorts).toHaveLength(0);
    writerPort.reply(['2026-11-23']);
    expect(await beforeReset).toEqual(['2026-11-23']);

    // Names always route to the dedicated names worker.
    const namesCall = router.call('names', ['agy:conv-1']);
    expect(namesPort.sent.at(-1)?.method).toBe('names');
    namesPort.reply({ 'agy:conv-1': 'Antigravity support' });
    expect(await namesCall).toEqual({ 'agy:conv-1': 'Antigravity support' });

    // Once writer emits reset, the WAL reader starts and handles pure read methods.
    writerPort.emit('message', { event: 'reset' });
    expect(readerPorts).toHaveLength(1);
    const readCall = router.call('daySummaries');
    expect(readerPorts[0]!.sent.at(-1)?.method).toBe('daySummaries');
    readerPorts[0]!.reply([]);
    expect(await readCall).toEqual([]);

    // Writer-only methods (including methods that prune/open ArchiveStore) stay on the writer.
    const evalCall = router.call('evalList');
    expect(writerPort.sent.at(-1)?.method).toBe('evalList');
    writerPort.reply([]);
    expect(await evalCall).toEqual([]);

    const closing = router.close();
    readerPorts[0]!.reply();
    namesPort.reply();
    writerPort.reply();
    await closing;
  });

  it('closes the reader around clear and starts a fresh reader afterward', async () => {
    const { router, writerPort, namesPort, readerPorts } = createHarness();
    router.start();
    writerPort.emit('message', { event: 'reset' });
    expect(readerPorts).toHaveLength(1);

    const clearing = router.call('clear');
    expect(readerPorts[0]!.sent.at(-1)?.method).toBe('close');
    readerPorts[0]!.reply();
    await new Promise((r) => setImmediate(r));
    expect(writerPort.sent.at(-1)?.method).toBe('clear');
    // Reads arriving while clear is running fall back to the writer instead of the closed reader.
    const duringClear = router.call('days');
    writerPort.reply();
    await clearing;
    expect(writerPort.sent.at(-1)?.method).toBe('days');
    writerPort.reply([]);
    expect(await duringClear).toEqual([]);

    // Fresh reader is spawned after clear finishes.
    expect(readerPorts).toHaveLength(2);
    const afterClear = router.call('days');
    expect(readerPorts[1]!.sent.at(-1)?.method).toBe('days');
    readerPorts[1]!.reply([]);
    expect(await afterClear).toEqual([]);

    const closing = router.close();
    readerPorts[1]!.reply();
    namesPort.reply();
    writerPort.reply();
    await closing;
  });
});
