import { ActivityLog } from './activityStore';
import { appPaths } from './paths';
import { getSecrets, getSettings } from './settingsStore';
export { lastDays, oldestKeptDay } from './activityStore';
/** Synchronous adapter for storage tests; production uses activityService. */
export const activityLog = new ActivityLog({
  get activityDb() { return appPaths.activityDb; },
  get legacyActivityDir() { return appPaths.legacyActivityDir; },
  get databaseKey() { return getSecrets().databaseKey; },
  get retentionDays() { return getSettings().activity.retentionDays; },
});
