import { Show } from 'solid-js';
import { activityImport } from '../store';
export const importLabel = () => `Importing local usage… ${activityImport().filesDone.toLocaleString()} / ${activityImport().filesTotal.toLocaleString()} files`;
export function ActivityImport() {
  return <>
    <Show when={activityImport().state === 'importing'}><span class="muted" role="status">{importLabel()}</span></Show>
    <Show when={activityImport().error}><span class="muted" role="alert">{activityImport().error}</span></Show>
  </>;
}
