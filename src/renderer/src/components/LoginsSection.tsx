import { HoverTip } from './ChartTip';
import { KeyRound, Plus, Trash2, Upload } from 'lucide-solid';
import { createSignal, For, Show } from 'solid-js';
import { accountState } from '@shared/accountState';
import type { Credential } from '@shared/types';
import { providerLabel } from '@shared/trayValues';
import { AddAccountDialog } from './AddAccountDialog';
import { CredentialActions, renewSummary } from './CredentialActions';
import { ResetCreditButton } from './ResetCreditButton';
import { ShowEmailsButton } from './ShowEmailsButton';
import { Dialog, Notice, NumberField, ProviderGlyph, Toggle } from './ui';
import { providerVar } from '../lib/providers';
import { now, proxyStatus, shownText, snapshot } from '../store';

const ICON_PX = 14;
/** Proxy rule (selector.go): only the highest available priority tier is picked from. */
const PRIORITY_HELP = 'Higher tiers are used first; lower tiers only when every higher account is limited';

function statusBadge(c: Credential, at: number) {
  switch (accountState(c, at)) {
    case 'disabled': return <span class="badge">Disabled</span>;
    case 'limited': return <span class="badge red">Limited</span>;
    case 'next-pick': return <span class="badge green">Next pick</span>;
    case 'error': return <HoverTip title="Account error" rows={[
      { label: 'Account', value: c.label },
      ...(c.statusMessage ? [{ label: 'Error', value: c.statusMessage }] : []),
    ]}><span class="badge red">Error</span></HoverTip>;
    case 'ready': return <span class="badge">Ready</span>;
  }
}

/** Signed-in subscription accounts (the proxy's login files), which the proxy rotates between. */
export function LoginsSection() {
  const [adding, setAdding] = createSignal(false);
  const [deleting, setDeleting] = createSignal<Credential | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [info, setInfo] = createSignal<string | null>(null);
  const running = () => proxyStatus()?.state === 'running';
  const creds = () =>
    (snapshot()?.credentials ?? []).filter((c) => !c.apiKey).sort((a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label));

  const report = (m: string) => { setError(null); setInfo(m); };
  const fail = (m: string) => { setInfo(null); setError(m); };
  const [renewingAll, setRenewingAll] = createSignal(false);
  const renewAll = async () => {
    setRenewingAll(true);
    await act(async () => {
      const s = renewSummary(await window.api.renewCredentials());
      if (s.error) fail([s.ok, s.error].filter(Boolean).join(' '));
      else report(s.ok ?? 'No accounts have a login token to renew.');
    });
    setRenewingAll(false);
  };
  const importFiles = () =>
    act(async () => {
      const r = await window.api.importCredentials();
      if (!r) return;
      const parts = [
        r.imported.length ? `Added ${r.imported.length} ${r.imported.length === 1 ? 'account' : 'accounts'}.` : '',
        r.replaced.length ? `Replaced ${r.replaced.join(', ')}.` : '',
      ].filter(Boolean);
      if (r.failed.length) fail([...parts, `Could not import: ${r.failed.map((f) => `${f.name} (${f.error})`).join('; ')}`].join(' '));
      else report(parts.join(' ') || 'Nothing imported.');
    });

  const act = async (fn: () => Promise<void>) => {
    setError(null);
    setInfo(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section class="page-section">
      <div class="section-head">
        <div class="spacer">
          <h2 class="card-title">Logins</h2>
          <div class="list-row-help">{creds().length} signed in · the proxy rotates between enabled accounts</div>
        </div>
        <div class="dash-actions">
          <ShowEmailsButton />
          <button class="btn" disabled={!running() || renewingAll()} title="Refresh every account's login token now" onClick={() => void renewAll()}>
            <KeyRound size={ICON_PX} class={renewingAll() ? 'spin' : undefined} /> Renew logins
          </button>
          <button class="btn" disabled={!running()} title="Add accounts from saved login files (.json)" onClick={() => void importFiles()}>
            <Upload size={ICON_PX} /> Import
          </button>
          <button class="btn primary" disabled={!running()} title={running() ? undefined : 'Start the proxy first'} onClick={() => setAdding(true)}>
            <Plus size={ICON_PX} /> Add account
          </button>
        </div>
      </div>

      <Show when={!running()}>
        <Notice>
          <span class="spacer">Accounts are managed through the proxy, which is {proxyStatus()?.state ?? 'stopped'}.</span>
          <button class="btn" onClick={() => void window.api.proxyStart()}>Start proxy</button>
        </Notice>
      </Show>
      <Show when={error()}>
        <Notice tone="error">{shownText(error()!)}</Notice>
      </Show>
      <Show when={info()}>
        <Notice tone="info">{shownText(info()!)}</Notice>
      </Show>

      <div class="card flush">
        <table class="table">
          <thead>
            <tr>
              <th>Account</th>
              <th>Provider</th>
              <th>Status</th>
              <th title={PRIORITY_HELP}>Priority</th>
              <th class="col-enabled">Enabled</th>
              <th class="row-actions" />
            </tr>
          </thead>
          <tbody>
            <For each={creds()} fallback={<tr><td colSpan={6} class="muted empty-row">No accounts yet. Use “Add account” to sign in.</td></tr>}>
              {(c) => (
                <tr class="card-wash" classList={{ disabled: c.disabled }} style={{ '--card-wash-hue': providerVar(c.provider) }}>
                  <td class="fill">
                    <div class="row">
                      <ProviderGlyph provider={c.provider} />
                      <div class="shrink">
                        <input
                          class="input inline-edit"
                          value={c.note ?? ''}
                          placeholder={c.label}
                          title="Account name (saved as the account note)"
                          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                          onBlur={(e) => {
                            const v = e.currentTarget.value.trim();
                            if (v !== (c.note ?? '')) void act(() => window.api.setCredentialNote(c.id, v));
                          }}
                        />
                        <HoverTip title="Account login" layout="block" rows={[
                          ...(c.email ? [{ label: 'Email', value: c.email }] : []),
                          { label: 'Auth file', value: c.name },
                        ]}><div class="muted truncate">{c.email ?? c.name}</div></HoverTip>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div class="row tight">
                      <HoverTip title="Subscription" rows={[
                        { label: 'Provider', value: providerLabel(c.provider) },
                        ...(c.plan?.label ? [{ label: 'Plan', value: c.plan.label }] : []),
                        ...(c.plan?.tier ? [{ label: 'Tier', value: c.plan.tier }] : []),
                      ]}><span>{providerLabel(c.provider)}{c.plan ? ` · ${c.plan.label}` : ''}</span></HoverTip>
                      <Show when={c.resetCredits?.available}>
                        <ResetCreditButton
                          credential={c}
                          disabled={!running()}
                          onDone={(m) => { setError(null); setInfo(m); }}
                          onError={(m) => { setInfo(null); setError(m); }}
                        />
                      </Show>
                    </div>
                  </td>
                  <td>{statusBadge(c, now())}</td>
                  <td>
                    <NumberField value={c.priority} narrow onCommit={(v) => void act(() => window.api.setCredentialPriority(c.id, v))} />
                  </td>
                  <td class="col-enabled">
                    <Toggle value={!c.disabled} label="Enabled" onChange={(on) => void act(() => window.api.setCredentialDisabled(c.id, !on))} />
                  </td>
                  <td class="row-actions">
                    <div class="row-actions-bar">
                      <CredentialActions credential={c} disabled={!running()} onDone={report} onError={fail} />
                      <button class="btn ghost icon-btn" title="Remove account" onClick={() => setDeleting(c)}>
                        <Trash2 size={ICON_PX} />
                      </button>
                    </div>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>

      <Show when={adding()}>
        <AddAccountDialog onClose={() => setAdding(false)} />
      </Show>
      <Show when={deleting()}>
        {(c) => (
          <Dialog
            title="Remove account?"
            onClose={() => setDeleting(null)}
            actions={
              <>
                <button class="btn" onClick={() => setDeleting(null)}>Cancel</button>
                <button
                  class="btn danger"
                  onClick={() => {
                    const target = c();
                    setDeleting(null);
                    void act(() => window.api.deleteCredential(target.id));
                  }}
                >
                  Remove
                </button>
              </>
            }
          >
            <p class="secondary">
              This deletes the saved login for <strong>{c().label}</strong> ({providerLabel(c().provider)}). You can sign in again later.
            </p>
          </Dialog>
        )}
      </Show>
    </section>
  );
}
