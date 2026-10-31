import { app, Notification } from 'electron';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { EVENTS } from '@shared/ipc';
import { ClientDrift } from './clientDrift';
import { applyClient, BACKUP_SUFFIX, CLIENT_IDS, clientConfigFiles, clientStatus } from './clientSetup';
import { managedPolicyFile, managedPolicyStatus } from './managedPolicy';
import { appIconPath, appPaths } from './paths';
import { proxy } from './proxySupervisor';
import { getSecrets, getSettings, onSettingsChange } from './settingsStore';
import { mainWindow, showMainWindow } from './window';

export const clientTarget = () => ({
  endpoint: proxy.getStatus().endpoint || `http://127.0.0.1:${getSettings().proxy.port}`,
  key: getSecrets().clientApiKey,
});

let monitor: ClientDrift | undefined;
export const clientIntent = (id: string, applied: boolean): void => monitor?.setIntent(id, applied);
export const clientMonitored = (id: string): boolean => monitor?.monitored(id) ?? false;
export const checkClientDrift = (): void => monitor?.schedule();

function openProxy(): void {
  showMainWindow();
  const contents = mainWindow()?.webContents;
  if (!contents) return;
  const send = () => contents.send(EVENTS.onOpenProxy);
  if (contents.isLoading()) contents.once('did-finish-load', send);
  else send();
}

export function startClientDrift(): void {
  const files = clientConfigFiles();
  const policy = managedPolicyFile();
  monitor = new ClientDrift({
    intentFile: path.join(appPaths.root, 'client-intent.json'),
    initialIntent: [...CLIENT_IDS.filter((id) => existsSync(`${files[id]}${BACKUP_SUFFIX}`)), ...(policy && existsSync(policy) ? ['managed-policy'] : [])],
    targets: [
      ...CLIENT_IDS.map((id) => ({ id, file: files[id],
        state: () => clientStatus(id, files[id], clientTarget()).state,
        status: () => clientStatus(id, files[id], clientTarget()),
        apply: () => applyClient(id, files[id], clientTarget()),
      })),
      ...(policy ? [{ id: 'managed-policy', file: policy,
        state: () => managedPolicyStatus(clientTarget(), policy)!.state,
        status: () => managedPolicyStatus(clientTarget(), policy),
      }] : []),
    ],
    mode: () => getSettings().proxy.clientDrift,
    targetKey: () => JSON.stringify(clientTarget()),
    changed: () => mainWindow()?.webContents.send(EVENTS.onClientSetupChanged),
    warn: (id) => {
      if (!Notification.isSupported()) return;
      const name = id === 'managed-policy' ? 'Claude Code managed policy' : id === 'claude' ? 'Claude Code' : 'Codex';
      const notification = new Notification({ title: 'Client proxy settings changed',
        body: `${name} is no longer configured for the current Spillway proxy. Open Proxy to review.`, icon: appIconPath() });
      notification.on('click', openProxy);
      notification.show();
    },
  });
  monitor.start();
  const unsubscribe = onSettingsChange(checkClientDrift);
  proxy.on('status', checkClientDrift);
  app.once('will-quit', () => {
    monitor?.stop();
    unsubscribe();
    proxy.off('status', checkClientDrift);
  });
}
