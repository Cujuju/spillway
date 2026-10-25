import { contextBridge, ipcRenderer } from 'electron';
import { EVENTS, INVOKE, SEND, type DesktopApi } from '@shared/ipc';

type Fn = (...args: unknown[]) => unknown;
const api: Record<string, unknown> = { platform: process.platform };

for (const [method, channel] of Object.entries(INVOKE)) {
  api[method] = ((...args: unknown[]) => ipcRenderer.invoke(channel, ...args)) satisfies Fn;
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
