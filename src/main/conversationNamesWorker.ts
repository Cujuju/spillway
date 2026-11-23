import { parentPort } from 'node:worker_threads';
import { conversationNames } from './conversationNames';
import type { Request } from './activityProtocol';

const port = parentPort!;
let queue = Promise.resolve();
port.on('message', (request: Request) => {
  queue = queue.then(async () => {
    try {
      if (request.method === 'close') {
        port.postMessage({ id: request.id, value: undefined });
        port.close();
        return;
      }
      if (request.method !== 'names') throw new Error(`Unsupported names worker method: ${request.method}`);
      const value = await conversationNames.names(...request.args);
      port.postMessage({ id: request.id, value });
    } catch (e) {
      port.postMessage({ id: request.id, error: e instanceof Error ? e.message : String(e) });
    }
  });
});
