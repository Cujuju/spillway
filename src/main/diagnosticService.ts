import { app, dialog } from 'electron';
import { parseBuildInfo } from '@shared/buildInfo';
import { activityLog } from './activityService';
import { getSecrets, getSettings } from './settingsStore';
import { proxy } from './proxySupervisor';
import { proxyIdentity } from './proxyIdentity';
import { mainWindow } from './window';
import { DiagnosticExporter } from './diagnosticExport';
import { Worker } from 'node:worker_threads';
import workerPath from './diagnosticWorker?modulePath';
import { DiagnosticFormatRpc } from './diagnosticFormatRpc';
import { DIAGNOSTIC_LIMITS } from '@shared/diagnosticBundle';

export const diagnosticExporter = new DiagnosticExporter({
  snapshot: (trace, bodies) => activityLog.call('diagnosticSnapshot', trace, bodies),
  context: async () => {
    const identity = proxyIdentity();
    const secrets = getSecrets();
    const logs = proxy.logs.all().filter((line) => line.stream === 'app');
    return { app: parseBuildInfo(app.getVersion(), __APP_BUILD__, null), proxy: proxy.getStatus(), settings: getSettings(),
      archive: await activityLog.call('archiveStatus'), logCount: logs.length, logs: logs.slice(-DIAGNOSTIC_LIMITS.logs).map((line) => ({ ...line, text: line.text.slice(0, 8192) })), knownSecrets: [secrets.clientApiKey, secrets.managementKey, secrets.databaseKey, secrets.clickhouse?.username ?? '', secrets.clickhouse?.password ?? '', ...identity.clientApiKeys, identity.managementKey ?? ''] };
  },
  formatter: (selection, context, now, signal) => new DiagnosticFormatRpc(new Worker(workerPath, { workerData: { selection, context, now } }), signal),
  pickPath: async (filename) => {
    const options: Electron.SaveDialogOptions = { title: 'Save inspected diagnostic bundle', defaultPath: filename, filters: [{ name: 'Diagnostic JSON', extensions: ['json'] }] };
    const window = mainWindow();
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    return result.canceled ? null : result.filePath ?? null;
  },
});

const timer = setInterval(() => diagnosticExporter.expire(), 30_000);
timer.unref();
export async function stopDiagnosticExport(): Promise<void> { clearInterval(timer); await diagnosticExporter.shutdown(); }
