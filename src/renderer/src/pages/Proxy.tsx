import { Eye, EyeOff, FilePen, Play, RefreshCw, RotateCw, Square } from 'lucide-solid';
import { createResource, createSignal, Show } from 'solid-js';
import { ClientSetup } from '../components/ClientSetup';
import { ManagementLockouts } from '../components/ManagementLockouts';
import { ShellEnvSetup } from '../components/ShellEnvSetup';
import { T3CodeSetup } from '../components/T3CodeSetup';
import { CopyButton, Dialog, Notice } from '../components/ui';
import { proxyStatus } from '../store';

const ICON_PX = 14;
/** Key characters left visible when masked; the rest become bullets so the masked key keeps its length. */
const KEY_PREFIX_SHOWN = 4;

export function Proxy() {
  const [keys, { mutate }] = createResource(() => window.api.proxyKeys());
  const [revealed, setRevealed] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [confirmingRegenerate, setConfirmingRegenerate] = createSignal(false);

  const state = () => proxyStatus()?.state ?? 'stopped';
  const running = () => state() === 'running';
  const endpoint = () => keys()?.endpoint ?? proxyStatus()?.endpoint ?? '';
  const key = () => keys()?.clientApiKey ?? '';
  const maskOf = (value: string) => (revealed() ? value : `${value.slice(0, KEY_PREFIX_SHOWN)}${'•'.repeat(Math.max(0, value.length - KEY_PREFIX_SHOWN))}`);
  const masked = () => maskOf(key());
  const managementKey = () => keys()?.managementKey ?? '';

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  const regenerate = () => {
    setConfirmingRegenerate(false);
    void run(() => window.api.regenerateClientKey().then(mutate));
  };

  return (
    <>
      <header class="dash-header">
        <div>
          <h1 class="dash-title">Proxy</h1>
        </div>
        <div class="dash-actions">
          <Show
            when={running() || state() === 'starting'}
            fallback={
              <button class="btn primary" disabled={busy() || state() === 'missing-binary'} onClick={() => void run(() => window.api.proxyStart())}>
                <Play size={ICON_PX} /> Start
              </button>
            }
          >
            <button class="btn" disabled={busy()} onClick={() => void run(() => window.api.proxyRestart())}>
              <RotateCw size={ICON_PX} /> Restart
            </button>
            <button class="btn danger" disabled={busy()} onClick={() => void run(() => window.api.proxyStop())}>
              <Square size={ICON_PX} /> Stop
            </button>
          </Show>
        </div>
      </header>

      <Show when={state() === 'port-busy'} fallback={<Show when={proxyStatus()?.lastError}><Notice tone="error">{proxyStatus()!.lastError}</Notice></Show>}>
        <Notice tone="error">Port {proxyStatus()?.port} is in use by another program. Quit it, or choose another port under Settings → Routing & server, then start again.</Notice>
      </Show>
      <Show when={proxyStatus()?.userConfigError}>
        <Notice tone="warn">config.user.yaml was ignored: {proxyStatus()!.userConfigError}. Fix and save it to apply.</Notice>
      </Show>
      <Show when={state() === 'missing-binary'}>
        <Notice tone="error">The cli-proxy-api binary was not found. Choose it under Settings → Routing & server, or rebuild the app with the bundled binary.</Notice>
      </Show>

      <section class="card">
        <div class="row wrap">
          <h2 class="card-title spacer">Connect clients</h2>
          <span class="chip">
            <span class="chip-label">Endpoint</span>
            <span class="chip-value selectable">{endpoint() || '—'}</span>
            <CopyButton chip value={endpoint()} what="endpoint" disabled={!endpoint()} />
          </span>
          <span class="chip">
            <span class="chip-label">Client key</span>
            <span class="chip-value selectable">{masked()}</span>
            <button class="chip-btn" title={revealed() ? 'Hide client key' : 'Show client key'} aria-label={revealed() ? 'Hide client key' : 'Show client key'} onClick={() => setRevealed(!revealed())}>
              <Show when={revealed()} fallback={<Eye size={ICON_PX} />}>
                <EyeOff size={ICON_PX} />
              </Show>
            </button>
            <CopyButton chip value={key()} what="client key" />
            <button class="chip-btn" title="Regenerate client key" aria-label="Regenerate client key" disabled={busy()} onClick={() => setConfirmingRegenerate(true)}>
              <RefreshCw size={ICON_PX} />
            </button>
          </span>
        </div>
        <ClientSetup endpoint={endpoint()} clientKey={key()} />
        <T3CodeSetup endpoint={endpoint()} clientKey={key()} masked={masked()} managementKey={managementKey()} maskedManagementKey={maskOf(managementKey())} />
        <ShellEnvSetup endpoint={endpoint()} clientKey={key()} masked={masked()} />
        <ManagementLockouts />
      </section>

      <section class="card">
        <div class="row">
          <div class="spacer">
            <h2 class="card-title">Custom proxy settings</h2>
            <div class="list-row-help">Keys in config.user.yaml are merged into the proxy config and applied when you save. App settings win where they overlap.</div>
          </div>
          <button class="btn" onClick={() => void window.api.openPath('userConfig')}><FilePen size={ICON_PX} /> Edit config.user.yaml</button>
        </div>
      </section>

      <Show when={confirmingRegenerate()}>
        <Dialog
          title="Regenerate client key?"
          onClose={() => setConfirmingRegenerate(false)}
          actions={
            <>
              <button class="btn" onClick={() => setConfirmingRegenerate(false)}>Cancel</button>
              <button class="btn danger" onClick={regenerate}>Regenerate</button>
            </>
          }
        >
          <p class="secondary">The proxy restarts, and clients using the old key stop working until you re-apply them.</p>
        </Dialog>
      </Show>
    </>
  );
}
