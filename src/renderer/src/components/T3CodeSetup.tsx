import { For } from 'solid-js';
import { CLAUDE_TOKEN_VAR, claudeEnvVars } from '@shared/claudeEnv';
import { CopyButton, ExpandRow } from './ui';

/** T3 Code runs Claude Code and Codex, so their Apply covers it; a Claude provider with its own home folder needs these variables. */
export function T3CodeSetup(props: { endpoint: string; clientKey: string; masked: string; managementKey: string; maskedManagementKey: string }) {
  const vars = () => {
    const shown = claudeEnvVars(props.endpoint, props.masked);
    return claudeEnvVars(props.endpoint, props.clientKey).map((v, i) => ({ ...v, shown: shown[i]?.value ?? '' }));
  };
  const hubFields = () => [
    { name: 'Hub URL', value: props.endpoint, shown: props.endpoint },
    { name: 'Management key', value: props.managementKey, shown: props.maskedManagementKey },
  ];
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
      <CopyRows rows={vars()} />
      <ol class="secondary steps">
        <li>To see every pooled account's quota in T3 Code, open Settings → Providers → Usage providers → Add a CLIProxyAPI hub, and enter these. Use this management key, not the client key above: the hub gets 401 with the client key.</li>
      </ol>
      <CopyRows rows={hubFields()} />
    </ExpandRow>
  );
}

function CopyRows(props: { rows: { name: string; value: string; shown: string }[] }) {
  return (
    <>
      <For each={props.rows}>
        {(v) => (
          <div class="row env-var">
            <span class="chip env-var-name"><span class="chip-value">{v.name}</span></span>
            <span class="selectable spacer tabular">{v.shown}</span>
            <CopyButton ghost value={v.value} what={v.name} />
          </div>
        )}
      </For>
    </>
  );
}
