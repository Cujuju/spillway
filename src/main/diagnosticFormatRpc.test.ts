import { Worker } from 'node:worker_threads';
import { expect, it } from 'vitest';
import { DiagnosticFormatRpc } from './diagnosticFormatRpc';

const source = { detail: null, attempts: [], attemptsOmitted: 0, attemptsUnavailable: 0 };
it('terminates CPU-bound formatting on cancellation without blocking the main event loop', async () => {
  const worker = new Worker("require('node:worker_threads').parentPort.on('message', () => { while (true) {} });", { eval: true });
  const controller = new AbortController(), rpc = new DiagnosticFormatRpc(worker, controller.signal);
  const work = rpc.add(source); setTimeout(() => controller.abort(), 20);
  await expect(work).rejects.toThrow('canceled'); await rpc.close();
});
it('allows only one raw record in flight and handles worker protocol errors', async () => {
  const worker = new Worker("const port = require('node:worker_threads').parentPort; port.on('message', (m) => { setTimeout(() => port.postMessage(m.method === 'add' ? {value:null} : {error:'synthetic format failure'}), 10); });", { eval: true });
  const rpc = new DiagnosticFormatRpc(worker, new AbortController().signal);
  try {
    const first = rpc.add(source); await expect(rpc.add(source)).rejects.toThrow('already busy'); await first;
    await expect(rpc.finish()).rejects.toThrow('synthetic format failure');
  } finally { await rpc.close(); }
});
it('rejects pending formatting if the worker exits or was already canceled', async () => {
  const rpc = new DiagnosticFormatRpc(new Worker('process.exit(0)', { eval: true }), new AbortController().signal);
  await expect(rpc.add(source)).rejects.toThrow('stopped'); await rpc.close();
  const canceled = new AbortController(); canceled.abort();
  const second = new DiagnosticFormatRpc(new Worker('', { eval: true }), canceled.signal);
  await expect(second.finish()).rejects.toThrow('canceled'); await second.close();
});
