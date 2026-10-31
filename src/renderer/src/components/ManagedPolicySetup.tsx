import { HoverTip } from './ChartTip';
import { createResource, createSignal, Show } from 'solid-js';
import type { ManagedPolicyStatus } from '@shared/types';
import { SETUP_STATE } from './ClientSetup';
import { Notice } from './ui';

const HELP =
  'Writes the endpoint and key into Claude Code’s machine-wide managed settings. Apps that skip your own settings (StockApp, ChattyPop) still read these, and they override every user’s settings on this computer. Needs administrator approval; Undo removes the file.';

/** Apply/Undo of Claude Code's managed policy; hidden where the platform has none. */
export function ManagedPolicySetup(props: { endpoint: string; clientKey: string }) {
  // Re-read on endpoint or key change, so a port change or new key shows as out of date.
  const [status, { mutate }] = createResource(
    () => (props.endpoint && props.clientKey ? `${props.endpoint} ${props.clientKey}` : false),
    () => window.api.managedPolicyStatus(),
  );
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const act = async (fn: () => Promise<ManagedPolicyStatus | null>) => {
    setBusy(true);
    setError(null);
    try {
      mutate(await fn());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Show when={status()}>
      {(s) => {
        const state = () => SETUP_STATE[s().state];
        return (
          <div class="list-row">
            <div class="list-row-text">
              <div class="list-row-label">
                Claude Code, every app
                <HoverTip title="Managed Claude Code setup" rows={[
                    { label: 'Status', value: state().label },
                    { label: 'Meaning', value: state().title.replace(/\.$/, '') },
                    ...(s().path ? [{ label: 'Config', value: s()!.path }] : []),
                  ]}><span class={`badge ${state().tone}`}>{state().label}</span></HoverTip>
              </div>
              <div class="list-row-help">{HELP}</div>
              <div class="list-row-help path">{s().path}</div>
              <Show when={s().error ?? error()}>{(message) => <div class="list-row-help error">{message()}</div>}</Show>
            </div>
            <div class="list-row-actions">
              <Show when={s().state !== 'not-applied'}>
                <button class="btn ghost" disabled={busy()} title="Remove the managed policy file" onClick={() => void act(window.api.undoManagedPolicy)}>
                  Undo
                </button>
              </Show>
              <button class="btn main-action" classList={{ primary: s().state === 'out-of-date' }} disabled={busy() || !!s().error} onClick={() => void act(window.api.applyManagedPolicy)}>
                {s().state === 'not-applied' ? 'Apply' : 'Re-apply'}
              </button>
            </div>
          </div>
        );
      }}
    </Show>
  );
}
