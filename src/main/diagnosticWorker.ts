import { parentPort, workerData } from 'node:worker_threads';
import { DiagnosticPreparation } from './diagnosticPreparation';
import type { DiagnosticSource } from '@shared/diagnosticBundle';

const preparation = new DiagnosticPreparation(workerData.selection, workerData.context, workerData.now);
parentPort!.on('message', (message: { method: 'add' | 'finish'; source?: DiagnosticSource }) => {
  try {
    const value = message.method === 'add' ? preparation.add(message.source!) : preparation.finish();
    parentPort!.postMessage({ value });
  } catch (error) { parentPort!.postMessage({ error: error instanceof Error ? error.message : 'Diagnostic formatting failed' }); }
});
