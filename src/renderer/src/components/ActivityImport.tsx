import { Show } from 'solid-js';
import { activityImport, archiveMigration } from '../store';
import { appLocale } from '@shared/timeFormat';
export const importLabel = () => `Importing local usage… ${activityImport().filesDone.toLocaleString(appLocale())} / ${activityImport().filesTotal.toLocaleString(appLocale())} files`;
export const migrating = () => archiveMigration().state === 'migrating';
/** After the last row, the old search index is dropped and its space reclaimed. */
export const migrationLabel = () => archiveMigration().done === archiveMigration().total
  ? 'Upgrading recorded bodies… finishing'
  : `Upgrading recorded bodies… ${archiveMigration().done.toLocaleString(appLocale())} / ${archiveMigration().total.toLocaleString(appLocale())} requests`;
export const MIGRATION_NOTE = 'One-time upgrade to the smaller storage format. Activity and Request capture wait until it finishes.';
export function ActivityImport() {
  return <>
    <Show when={migrating()}><span class="muted" role="status" title={MIGRATION_NOTE}>{migrationLabel()}</span></Show>
    <Show when={activityImport().state === 'importing'}><span class="muted" role="status">{importLabel()}</span></Show>
    <Show when={activityImport().error}><span class="muted" role="alert">{activityImport().error}</span></Show>
  </>;
}
