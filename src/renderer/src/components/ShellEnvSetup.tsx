import { Copy } from 'lucide-solid';
import { createSignal } from 'solid-js';
import { ExpandRow, Seg } from './ui';

const ICON_PX = 14;

type Shell = 'powershell' | 'bash';
const SHELLS = [{ value: 'powershell', label: 'PowerShell' }, { value: 'bash', label: 'Bash' }] as const;

/** Env vars Claude Code reads to send traffic through a proxy. */
const envSnippet = (shell: Shell, endpoint: string, key: string) =>
  shell === 'powershell'
    ? `$env:ANTHROPIC_BASE_URL = "${endpoint}"\n$env:ANTHROPIC_AUTH_TOKEN = "${key}"`
    : `export ANTHROPIC_BASE_URL=${endpoint}\nexport ANTHROPIC_AUTH_TOKEN=${key}`;

/** Points one shell session's Claude Code at the proxy, leaving its settings file alone. */
export function ShellEnvSetup(props: { endpoint: string; clientKey: string; masked: string }) {
  const [shell, setShell] = createSignal<Shell>('powershell');
  return (
    <ExpandRow label="Shell session" help="Environment variables that point Claude Code at the proxy for one terminal session." action="Variables">
      <div class="row env-var">
        <Seg value={shell()} options={SHELLS} onChange={setShell} />
        <span class="spacer" />
        <button class="btn" onClick={() => void window.api.copyText(envSnippet(shell(), props.endpoint, props.clientKey))}>
          <Copy size={ICON_PX} /> Copy
        </button>
      </div>
      <pre class="snippet selectable">{envSnippet(shell(), props.endpoint, props.masked)}</pre>
    </ExpandRow>
  );
}
