import { Copy, Eye, EyeOff, FilePen, FolderOpen, Play, RotateCw, Square } from 'lucide-solid';
import { createEffect, createResource, createSignal, For, on, Show } from 'solid-js';
import { Notice } from '../components/ui';
import { logs, proxyStatus, setLogs } from '../store';

const ICON_PX = 14;
/** Within this share of a screen from the bottom counts as following the tail. */
const FOLLOW_TAIL_SHARE = 0.25;

/** Env vars Claude Code reads to send traffic through a proxy. */
const bashEnv = (endpoint: string, key: string) =>
  `export ANTHROPIC_BASE_URL=${endpoint}\nexport ANTHROPIC_AUTH_TOKEN=${key}`;
const powershellEnv = (endpoint: string, key: string) =>
  `$env:ANTHROPIC_BASE_URL = "${endpoint}"\n$env:ANTHROPIC_AUTH_TOKEN = "${key}"`;

export function Proxy() {
  const [keys, { mutate }] = createResource(() => window.api.proxyKeys());
  const [revealed, setRevealed] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [envShell, setEnvShell] = createSignal<'powershell' | 'bash'>('powershell');
  let logBox!: HTMLDivElement;

  const state = () => proxyStatus()?.state ?? 'stopped';
  const running = () => state() === 'running';
  const endpoint = () => keys()?.endpoint ?? proxyStatus()?.endpoint ?? '';
  const key = () => keys()?.clientApiKey ?? '';
  const masked = () => (revealed() ? key() : `${key().slice(0, 4)}${'•'.repeat(20)}`);
  const snippet = () => (envShell() === 'powershell' ? powershellEnv(endpoint(), key()) : bashEnv(endpoint(), key()));

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  // Follow the log tail unless the user scrolled up to read.
  createEffect(on(logs, () => {
    if (!logBox) return;
    const atBottom = logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < logBox.clientHeight * FOLLOW_TAIL_SHARE;
    if (atBottom) queueMicrotask(() => (logBox.scrollTop = logBox.scrollHeight));
  }));

  return (
    <>
      <header class="dash-header">
        <div>
          <h1 class="dash-title">Proxy</h1>
          <div class="dash-sub">CLIProxyAPI on {endpoint() || '—'}</div>
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

      <section class="card" style={{ 'margin-top': '16px' }}>
        <h2 class="card-title">Connect Claude Code</h2>
        <p class="secondary">Point Claude Code at the proxy with these environment variables. The key below is this app's client key.</p>
        <div class="row" style={{ 'margin-bottom': '10px' }}>
          <span class="code selectable spacer">{masked()}</span>
          <button class="btn ghost icon-btn" title={revealed() ? 'Hide key' : 'Show key'} onClick={() => setRevealed(!revealed())}>
            <Show when={revealed()} fallback={<Eye size={ICON_PX} />}>
              <EyeOff size={ICON_PX} />
            </Show>
          </button>
          <button class="btn" onClick={() => void window.api.copyText(key())}><Copy size={ICON_PX} /> Copy key</button>
          <button class="btn ghost" onClick={() => void window.api.regenerateClientKey().then(mutate)} title="Issues a new key and restarts the proxy; old clients stop working">
            Regenerate
          </button>
        </div>
        <div class="row" style={{ 'margin-bottom': '6px' }}>
          <div class="seg">
            <button classList={{ active: envShell() === 'powershell' }} onClick={() => setEnvShell('powershell')}>PowerShell</button>
            <button classList={{ active: envShell() === 'bash' }} onClick={() => setEnvShell('bash')}>Bash</button>
          </div>
          <span class="spacer" />
          <button class="btn" onClick={() => void window.api.copyText(snippet())}><Copy size={ICON_PX} /> Copy</button>
        </div>
        <pre class="code selectable" style={{ margin: 0 }}>{revealed() ? snippet() : snippet().replace(key(), masked())}</pre>
      </section>

      <section class="card" style={{ 'margin-top': '16px' }}>
        <div class="row">
          <div class="spacer">
            <h2 class="card-title" style={{ margin: 0 }}>Custom proxy settings</h2>
            <p class="secondary" style={{ margin: '4px 0 0' }}>Keys in config.user.yaml are merged into the proxy config and applied when you save. App settings win where they overlap.</p>
          </div>
          <button class="btn" onClick={() => void window.api.openPath('userConfig')}><FilePen size={ICON_PX} /> Edit config.user.yaml</button>
        </div>
      </section>

      <section class="card" style={{ 'margin-top': '16px' }}>
        <div class="row" style={{ 'margin-bottom': '10px' }}>
          <h2 class="card-title spacer" style={{ margin: 0 }}>Log</h2>
          <button class="btn ghost" onClick={() => void window.api.openPath('logs')}><FolderOpen size={ICON_PX} /> Open folder</button>
          <button class="btn ghost" onClick={() => void window.api.clearProxyLogs().then(() => setLogs([]))}>Clear</button>
        </div>
        <div class="log-view selectable" ref={logBox}>
          <For each={logs()} fallback={<div class="muted">No output yet.</div>}>
            {(l) => (
              <div classList={{ 'log-err': l.stream === 'stderr', 'log-app': l.stream === 'app' }}>
                <span class="muted">{new Date(l.at).toLocaleTimeString()}</span> {l.text}
              </div>
            )}
          </For>
        </div>
      </section>
    </>
  );
}
