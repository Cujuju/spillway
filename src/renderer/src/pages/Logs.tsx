import { FolderOpen } from 'lucide-solid';
import { createEffect, For, on } from 'solid-js';
import { Toggle } from '../components/ui';
import { logs, setLogs, settings, updateSettings } from '../store';

const ICON_PX = 14;
/** Within this share of a screen from the bottom counts as following the tail. */
const FOLLOW_TAIL_SHARE = 0.25;

/** Proxy and supervisor output; the view fills the page height. */
export function Logs() {
  let logBox!: HTMLDivElement;

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
          <h1 class="dash-title">Logs</h1>
          <div class="dash-sub">Proxy output and supervisor events · {logs().length} lines</div>
        </div>
        <div class="dash-actions">
          <span class="muted" title="Saves every request and response, prompts included, under the proxy folder's logs. Failed requests are saved either way. Files grow quickly; turn it off when done.">
            Record all requests
          </span>
          <Toggle
            label="Record all requests"
            value={settings().proxy.requestLog}
            onChange={(v) => void updateSettings((d) => void (d.proxy.requestLog = v))}
          />
          <button class="btn ghost" onClick={() => void window.api.openPath('logs')}><FolderOpen size={ICON_PX} /> Open folder</button>
          <button class="btn ghost" onClick={() => void window.api.clearProxyLogs().then(() => setLogs([]))}>Clear</button>
        </div>
      </header>
      <div class="log-view selectable" ref={logBox}>
        <For each={logs()} fallback={<div class="muted">No output yet.</div>}>
          {(l) => (
            <div classList={{ 'log-err': l.stream === 'stderr', 'log-app': l.stream === 'app' }}>
              <span class="muted">{new Date(l.at).toLocaleTimeString()}</span> {l.text}
            </div>
          )}
        </For>
      </div>
    </>
  );
}
