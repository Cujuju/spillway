import { randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { dialog } from 'electron';
import type { EvalExportPreview } from '@shared/evalCase';
import { activityLog } from './activityService';
import { EvalReplay } from './evalReplay';
import { proxy } from './proxySupervisor';
import { proxyIdentity } from './proxyIdentity';
import { getSecrets } from './settingsStore';
import { decodeCaseFile, encodeCaseFile, redactExport } from './evalCaseCodec';

export const evalReplay = new EvalReplay(() => {
  const status = proxy.getStatus();
  if (status.state !== 'running' || !status.endpoint) throw new Error('Start the local proxy before previewing replay');
  const clientApiKey = proxyIdentity().clientApiKeys[0];
  if (!clientApiKey) throw new Error('Proxy client authentication is unavailable');
  return { endpoint: status.endpoint, clientApiKey };
});
let frozen: (EvalExportPreview & { expires: number }) | null = null;
let exportGeneration = 0, replayGeneration = 0, deleting = 0;
export const forgetEvalExport = () => { frozen = null; exportGeneration++; };
export const invalidateEval = (id?: string) => { replayGeneration++; evalReplay.forget(id); forgetEvalExport(); };
export async function withEvalDeletion<T>(operation: () => Promise<T>): Promise<T> {
  deleting++; invalidateEval();
  try { return await operation(); } finally { invalidateEval(); deleting--; }
}
export async function prepareEvalReplay(id: string, revision: number) {
  if (deleting) throw new Error('Activity deletion is in progress');
  const generation = ++replayGeneration, c = await activityLog.call('evalGet', id, revision);
  if (generation !== replayGeneration) throw new Error('Eval replay preparation was canceled');
  return evalReplay.prepare(c);
}
export async function prepareEvalExport(id: string, revision: number, includeBodies: boolean): Promise<EvalExportPreview> {
  if (deleting) throw new Error('Activity deletion is in progress');
  const generation = ++exportGeneration;
  frozen = null;
  const source = await activityLog.call('evalExport', id, revision, includeBodies);
  if (generation !== exportGeneration) throw new Error('Eval export preparation was canceled');
  const credentials = getSecrets(), identity = proxyIdentity();
  const c = decodeCaseFile(Buffer.from(source)).cases[0]!;
  const knownSecrets = [credentials.clientApiKey, credentials.managementKey, credentials.databaseKey, credentials.clickhouse?.password, ...identity.clientApiKeys, identity.managementKey, identity.managementSecret].filter((v): v is string => typeof v === 'string');
  const jsonl = encodeCaseFile(redactExport(c, includeBodies === true, knownSecrets));
  const preview = { token: randomUUID(), jsonl, bytes: Buffer.byteLength(jsonl), includesBodies: includeBodies === true };
  frozen = { ...preview, expires: Date.now() + 5 * 60_000 }; return preview;
}
export async function saveEvalExport(token: string): Promise<string | null> {
  const snapshot = frozen;
  if (!snapshot || snapshot.token !== token || Date.now() >= snapshot.expires) throw new Error('Prepare and review a fresh eval export');
  const r = await dialog.showSaveDialog({ title: 'Save reviewed eval case', defaultPath: 'spillway-eval.jsonl', filters: [{ name: 'Eval case JSON Lines', extensions: ['jsonl'] }] });
  if (r.canceled || !r.filePath) return null;
  if (frozen !== snapshot || Date.now() >= snapshot.expires) throw new Error('Eval export was canceled or expired');
  frozen = null;
  const generation = exportGeneration;
  const temp = path.join(path.dirname(r.filePath), `.spillway-eval-${token}.partial`);
  let owned = false;
  try {
    const handle = await open(temp, 'wx', 0o600); owned = true;
    try { await handle.writeFile(snapshot.jsonl, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    if (generation !== exportGeneration) throw new Error('Eval export was canceled before finalizing');
    await rename(temp, r.filePath); owned = false; return r.filePath;
  } finally { if (owned) await unlink(temp); }
}
export async function importEvalFile() {
  const r = await dialog.showOpenDialog({ title: 'Import eval cases or exported exchanges', properties: ['openFile'], filters: [{ name: 'Portable JSON Lines', extensions: ['jsonl'] }] });
  if (r.canceled || !r.filePaths[0]) return [];
  return activityLog.call('evalImport', r.filePaths[0]);
}
