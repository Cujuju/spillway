import { Copy } from 'lucide-solid';
import { For } from 'solid-js';

const ICON_PX = 14;

/** Steps for T3 Code: its Claude provider takes per-instance environment variables; its Codex provider reads ~/.codex/config.toml. */
export function T3CodeSetup(props: { endpoint: string; clientKey: string; masked: string }) {
  const vars = () => [
    { name: 'ANTHROPIC_BASE_URL', value: props.endpoint, shown: props.endpoint, sensitive: false },
    { name: 'ANTHROPIC_AUTH_TOKEN', value: props.clientKey, shown: props.masked, sensitive: true },
  ];
  return (
    <div class="t3-setup">
      <h3 class="setting-label">T3 Code</h3>
      <ol class="secondary steps">
        <li>In T3 Code, open Settings → Providers and pick the Claude provider (or add a new Claude instance to keep a direct one too).</li>
        <li>Under Environment variables, add these two. Mark the token as sensitive.</li>
        <li>Save, then start a new thread with that provider.</li>
      </ol>
      <For each={vars()}>
        {(v) => (
          <div class="row" style={{ 'margin-bottom': '6px' }}>
            <span class="code" style={{ 'min-width': '190px' }}>{v.name}</span>
            <span class="code selectable spacer">{v.shown}</span>
            <button class="btn ghost" title={`Copy ${v.name}`} onClick={() => void window.api.copyText(v.value)}>
              <Copy size={ICON_PX} /> Copy
            </button>
          </div>
        )}
      </For>
      <p class="secondary">
        Codex in T3 Code uses the same config file as the Codex CLI, so Apply for Codex above covers it. Applying Claude Code above also covers T3 Code's
        Claude provider unless that provider uses its own home folder.
      </p>
    </div>
  );
}
