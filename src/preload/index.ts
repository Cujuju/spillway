import { createNoticeBridge } from '@cujuju/electron-notices';
import { contextBridge, ipcRenderer } from 'electron';
import { EVENTS, INVOKE, SEND, type DesktopApi } from '@shared/ipc';
import { unwrapRemoteError } from '@shared/ipcError';
import { HOUR_CYCLE_ARG, parseHourCycle } from '@shared/timeFormat';

type Fn = (...args: unknown[]) => unknown;
const hourCycle = parseHourCycle(process.argv.find((a) => a.startsWith(HOUR_CYCLE_ARG))?.slice(HOUR_CYCLE_ARG.length));
const api: Record<string, unknown> = { platform: process.platform, hourCycle };

for (const [method, channel] of Object.entries(INVOKE)) {
  api[method] = ((...args: unknown[]) => ipcRenderer.invoke(channel, ...args).catch(unwrapRemoteError)) satisfies Fn;
}
for (const [method, channel] of Object.entries(SEND)) {
  api[method] = (() => ipcRenderer.send(channel)) satisfies Fn;
}
for (const [method, channel] of Object.entries(EVENTS)) {
  api[method] = (cb: (payload: unknown) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('api', api as unknown as DesktopApi);

contextBridge.exposeInMainWorld('notices', createNoticeBridge(ipcRenderer));
