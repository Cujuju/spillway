import { CLAUDE_TOKEN_VAR, claudeEnvVars } from '@shared/claudeEnv';
import { persistedSignal } from '../lib/persisted';
import { DEFAULT_SHELL } from '../lib/platform';
import { CopyButton, ExpandRow, Seg } from './ui';

type Shell = 'powershell' | 'bash';
const SHELLS = [{ value: 'powershell', label: 'PowerShell' }, { value: 'bash', label: 'Bash' }] as const;

/** Env vars Claude Code reads to send traffic through a proxy; clears a leftover token that would switch it to token mode. */
const envSnippet = (shell: Shell, endpoint: string, key: string) =>
  [
    shell === 'powershell' ? `Remove-Item Env:${CLAUDE_TOKEN_VAR} -ErrorAction SilentlyContinue` : `unset ${CLAUDE_TOKEN_VAR}`,
    ...claudeEnvVars(endpoint, key).map(({ name, value }) => (shell === 'powershell' ? `$env:${name} = "${value}"` : `export ${name}="${value}"`)),
  ].join('\n');

/** Points one shell session's Claude Code at the proxy, leaving its settings file alone. */
export function ShellEnvSetup(props: { endpoint: string; clientKey: string; masked: string }) {
  const [shell, setShell] = persistedSignal<Shell>('proxy.shell', DEFAULT_SHELL, SHELLS.map((s) => s.value));
  return (
    <ExpandRow stateKey="proxy.shellSession" label="Shell session" help="Environment variables that point Claude Code at the proxy for one terminal session." action="Variables">
      <div class="row env-var">
        <Seg value={shell()} options={SHELLS} onChange={setShell} />
        <span class="spacer" />
        <CopyButton value={envSnippet(shell(), props.endpoint, props.clientKey)} what="variables" />
      </div>
      <pre class="snippet selectable">{envSnippet(shell(), props.endpoint, props.masked)}</pre>
    </ExpandRow>
  );
}
