import { spillwayNotice } from '@shared/notice';
import { app } from 'electron';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { EVENTS } from '@shared/ipc';
import { notify } from './notifier';
import { ClientDrift } from './clientDrift';
import { applyClient, BACKUP_SUFFIX, CLIENT_IDS, clientConfigFiles, clientStatus } from './clientSetup';
import { managedPolicyFile, managedPolicyStatus } from './managedPolicy';
import { appPaths } from './paths';
import { proxy } from './proxySupervisor';
import { proxyIdentity } from './proxyIdentity';
import { getSettings, onSettingsChange } from './settingsStore';
import { mainWindow } from './window';

export const clientTarget = () => ({
  endpoint: proxy.getStatus().endpoint || `http://127.0.0.1:${getSettings().proxy.port}`,
  key: proxyIdentity().clientApiKeys[0]!,
});

let monitor: ClientDrift | undefined;
export const clientIntent = (id: string, applied: boolean): void => monitor?.setIntent(id, applied);
export const clientMonitored = (id: string): boolean => monitor?.monitored(id) ?? false;
export const checkClientDrift = (): void => monitor?.schedule();

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
      const name = id === 'managed-policy' ? 'Claude Code managed policy' : id === 'claude' ? 'Claude Code' : 'Codex';
      notify(spillwayNotice('clientDrift', { target: 'proxy', title: 'Client proxy settings changed',
        body: `${name} is no longer configured for the current Spillway proxy. Open Proxy to review.`, short: `${name} changed` }));
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
