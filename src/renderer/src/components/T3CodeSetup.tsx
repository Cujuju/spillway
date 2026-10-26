import { Copy } from 'lucide-solid';
import { For } from 'solid-js';
import { CLAUDE_TOKEN_VAR, claudeEnvVars } from '@shared/claudeEnv';
import { ExpandRow } from './ui';

const ICON_PX = 14;

/** T3 Code runs Claude Code and Codex, so their Apply covers it; a Claude provider with its own home folder needs these variables. */
export function T3CodeSetup(props: { endpoint: string; clientKey: string; masked: string }) {
  const vars = () => {
    const shown = claudeEnvVars(props.endpoint, props.masked);
    return claudeEnvVars(props.endpoint, props.clientKey).map((v, i) => ({ ...v, shown: shown[i]?.value ?? '' }));
  };
  return (
    <ExpandRow
      label="T3 Code"
      help="Covered by Apply above, unless its Claude provider has its own home folder."
      action="Steps"
    >
      <ol class="secondary steps">
        <li>In T3 Code, open Settings → Providers and pick the Claude provider (or add a Claude instance to keep a direct one too).</li>
        <li>Under Environment variables, add these two and mark the second as sensitive. Remove {CLAUDE_TOKEN_VAR} if it is there: it stops T3 Code from seeing usage-limit resets.</li>
        <li>Keep that provider signed in to Claude; requests still use the proxy's accounts.</li>
        <li>Save, then start a new thread with that provider.</li>
      </ol>
      <For each={vars()}>
        {(v) => (
          <div class="row env-var">
            <span class="chip env-var-name"><span class="chip-value">{v.name}</span></span>
            <span class="selectable spacer tabular">{v.shown}</span>
            <button class="btn ghost" title={`Copy ${v.name}`} onClick={() => void window.api.copyText(v.value)}>
              <Copy size={ICON_PX} /> Copy
            </button>
          </div>
        )}
      </For>
    </ExpandRow>
  );
}
