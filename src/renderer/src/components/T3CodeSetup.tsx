import { For, type JSX } from 'solid-js';
import { CLAUDE_TOKEN_VAR, claudeEnvVars } from '@shared/claudeEnv';
import { CopyButton, ExpandRow } from './ui';

interface Field {
  name: string;
  value: string;
  shown: string;
}

/** T3 Code runs Claude Code and Codex, so their Apply covers it; a Claude provider with its own home folder needs these variables. */
export function T3CodeSetup(props: {
  endpoint: string;
  clientKey: string;
  masked: string;
  /** Null when sharedFrom's key is used: this build holds only its hash. */
  managementKey: string | null;
  maskedManagementKey: string;
  sharedFrom: string | null;
}) {
  const vars = (): Field[] => {
    const shown = claudeEnvVars(props.endpoint, props.masked);
    return claudeEnvVars(props.endpoint, props.clientKey).map((v, i) => ({ ...v, shown: shown[i]?.value ?? '' }));
  };
  const hubFields = (): Field[] => [
    { name: 'Hub URL', value: props.endpoint, shown: props.endpoint },
    ...(props.managementKey === null ? [] : [{ name: 'Management key', value: props.managementKey, shown: props.maskedManagementKey }]),
  ];
  const hubKeyHelp = () =>
    props.sharedFrom
      ? `Use ${props.sharedFrom}'s management key (its Proxy page → T3 Code); this build accepts the same one.`
      : 'Use this management key, not the client key: the hub gets 401 with the client key.';
  return (
    <ExpandRow stateKey="proxy.t3Code" label="T3 Code" help="Covered by Apply above, unless its Claude provider has its own home folder." action="Steps">
      <SetupGroup
        title="Claude provider with its own home folder"
        help={
          <>
            Settings → Providers → the Claude provider → Environment variables. Add these, mark the second as sensitive, and remove {CLAUDE_TOKEN_VAR} if it is
            there (it hides usage-limit resets). Keep the provider signed in to Claude, then start a new thread.
          </>
        }
        fields={vars()}
      />
      <SetupGroup
        title="Usage hub (every pooled account's quota)"
        help={`Settings → Providers → Usage providers → Add a CLIProxyAPI hub. ${hubKeyHelp()}`}
        fields={hubFields()}
      />
    </ExpandRow>
  );
}

function SetupGroup(props: { title: string; help: JSX.Element; fields: Field[] }) {
  return (
    <div class="setup-group">
      <div class="list-row-label">{props.title}</div>
      <div class="list-row-help">{props.help}</div>
      <div class="setup-fields">
        <For each={props.fields}>
          {(f) => (
            <span class="chip setup-field">
              <span class="chip-label">{f.name}</span>
              <span class="chip-value selectable">{f.shown}</span>
              <CopyButton chip value={f.value} what={f.name} />
            </span>
          )}
        </For>
      </div>
    </div>
  );
}
