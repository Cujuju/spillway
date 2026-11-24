import { validateClickHouseConfig, validateClickHouseCredentials, type ClickHouseConfig, type ClickHouseCredentials, type ClickHouseStatus } from '@shared/clickhouse';
import { activityLog } from './activityService';
import { getSecrets, setClickHouseCredentials } from './settingsStore';
import { ClickHouseUploader } from './clickhouseUploader';
import { ClickHouseActivityReader } from './clickhouseRead';

const credentialsFor = (config: ClickHouseConfig) => {
  const c = getSecrets().clickhouse;
  return c?.endpoint === config.endpoint ? c : undefined;
};
export const clickhouseActivityReader = new ClickHouseActivityReader(
  () => activityLog.call('clickhouseStatus'), () => activityLog.call('activityOlderBoundaries'), credentialsFor,
);
export const clickhouseUploader = new ClickHouseUploader({
  status: () => activityLog.call('clickhouseStatus'), prepare: () => activityLog.call('clickhousePrepare'),
  acknowledge: (token, destination) => activityLog.call('clickhouseAcknowledge', token, destination), fail: (token, now, error) => activityLog.call('clickhouseFail', token, now, error),
}, credentialsFor);
let operations = Promise.resolve();
let pauseGeneration = 0;
let shuttingDown = false;
let cancelled = false;
export function withClickHousePaused<T>(action: () => Promise<T>, resume = false): Promise<T> {
  const generation = pauseGeneration;
  const result = operations.then(async () => {
    await clickhouseUploader.stop();
    let succeeded = false;
    try { const result = await action(); succeeded = true; return result; }
    finally {
      if (resume && succeeded && generation === pauseGeneration) cancelled = false;
      if (!shuttingDown && !cancelled && generation === pauseGeneration) clickhouseUploader.start();
    }
  });
  operations = result.then(() => undefined, () => undefined);
  return result;
}
export async function clickhouseStatus(): Promise<ClickHouseStatus> {
  const state = await activityLog.call('clickhouseStatus');
  return { ...state, hasCredentials: getSecrets().clickhouse?.endpoint === state.config.endpoint, running: clickhouseUploader.running, paused: state.config.deliveryPaused || clickhouseUploader.paused, error: clickhouseUploader.error ?? state.error };
}
export async function cancelClickHouse(shutdown = false): Promise<void> {
  pauseGeneration++; shuttingDown ||= shutdown; cancelled = true;
  if (shutdown) clickhouseActivityReader.stop();
  await clickhouseUploader.stop();
  await operations;
}
export function saveClickHouse(raw: ClickHouseConfig, rawCredentials?: ClickHouseCredentials | null): Promise<ClickHouseStatus> {
  const config = validateClickHouseConfig(raw);
  const credentials = rawCredentials === undefined || rawCredentials === null ? rawCredentials : validateClickHouseCredentials(rawCredentials);
  return withClickHousePaused(async () => {
    const prev = await activityLog.call('clickhouseStatus');
    const changed = prev.config.endpoint !== config.endpoint || prev.config.database !== config.database || prev.config.tablePrefix !== config.tablePrefix;
    // The worker discards the old destination's queue before secrets change; a crash leaves the new destination disabled.
    if (changed) await activityLog.call('clickhouseConfigure', { ...config, enabled: false });
    if (credentials !== undefined) {
      // Blank fields keep their saved value on the same endpoint; Forget sends null.
      const saved = prev.config.endpoint === config.endpoint ? credentialsFor(config) : undefined;
      const merged = credentials && saved ? { username: credentials.username || saved.username, password: credentials.password || saved.password } : credentials;
      await setClickHouseCredentials(merged, config.endpoint);
    } else if (prev.config.endpoint !== config.endpoint) await setClickHouseCredentials(null);
    await activityLog.call('clickhouseConfigure', config);
    clickhouseUploader.error = null;
    return clickhouseStatus();
  }, !config.deliveryPaused);
}
export function diagnoseClickHouse(create: boolean): Promise<string> {
  return withClickHousePaused(async () => {
    const state = await activityLog.call('clickhouseStatus');
    const result = await clickhouseUploader.diagnose(state.config, create === true);
    // A passing check makes the stored delivery error stale; upload now instead of after backoff.
    if (!state.config.deliveryPaused) await activityLog.call('clickhouseRetry');
    return result;
  });
}
export function retryClickHouse(): Promise<void> {
  return withClickHousePaused(async () => { await activityLog.call('clickhouseRetry'); clickhouseUploader.error = null; }, true);
}
export function clearClickHouse(): Promise<void> {
  return withClickHousePaused(async () => { await activityLog.call('clickhouseClear'); clickhouseUploader.error = null; });
}
