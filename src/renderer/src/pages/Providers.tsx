import { Pencil, Plus, Trash2 } from 'lucide-solid';
import { createResource, createSignal, For, Show } from 'solid-js';
import { FAMILY_INFO, type ApiProviderGroup, type ApiProviderTarget } from '@shared/apiProviders';
import { ProviderDialog } from '../components/ProviderDialog';
import { Dialog, Notice, ProviderGlyph } from '../components/ui';

const ICON_PX = 14;

/** API-key upstreams and OpenAI-compatible endpoints, stored in config.user.yaml's `api-keys` section. */
export function Providers() {
  const [list, { mutate, refetch }] = createResource(() => window.api.apiProviders());
  const [editing, setEditing] = createSignal<{ target: ApiProviderTarget; group: ApiProviderGroup | null } | null>(null);
  const [deleting, setDeleting] = createSignal<ApiProviderGroup | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const groups = () => list()?.groups ?? [];
  const fileError = () => list()?.error ?? null;

  const remove = async (g: ApiProviderGroup) => {
    setDeleting(null);
    setError(null);
    try {
      mutate({ groups: await window.api.deleteApiProvider(g.family, g.name), error: null });
    } catch (e) {
      setError((e as Error).message);
      void refetch();
    }
  };

  return (
    <>
      <header class="dash-header">
        <div>
          <h1 class="dash-title">Providers</h1>
          <div class="dash-sub">API keys and OpenAI-compatible endpoints the proxy routes to, beside signed-in accounts</div>
        </div>
        <div class="dash-actions">
          <button class="btn" title="Every custom proxy setting, providers included" onClick={() => void window.api.openPath('userConfig')}>
            Open config.user.yaml
          </button>
          <button class="btn primary" disabled={!!fileError()} onClick={() => setEditing({ target: null, group: null })}>
            <Plus size={ICON_PX} /> Add provider
          </button>
        </div>
      </header>

      <Show when={fileError()}>
        <Notice tone="error">
          <span class="spacer">{fileError()}</span>
          <button class="btn" onClick={() => void refetch()}>Reload</button>
        </Notice>
      </Show>
      <Show when={error()}>
        <Notice tone="error">{error()}</Notice>
      </Show>

      <div class="card" style={{ padding: 0 }}>
        <table class="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Endpoint</th>
              <th>Keys</th>
              <th>Models</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <For
              each={groups()}
              fallback={
                <tr>
                  <td colSpan={6} class="muted" style={{ padding: '24px', 'text-align': 'center' }}>
                    {list.loading ? 'Loading…' : 'No API-key providers. Signed-in accounts are on the Accounts page.'}
                  </td>
                </tr>
              }
            >
              {(g) => (
                <tr classList={{ disabled: g.disabled }}>
                  <td>
                    <div class="row">
                      <ProviderGlyph provider={FAMILY_INFO[g.family].glyph} />
                      <span class="truncate">{g.name}</span>
                      <Show when={g.disabled}><span class="badge">Off</span></Show>
                    </div>
                  </td>
                  <td>{FAMILY_INFO[g.family].label}</td>
                  <td class="truncate" title={g.baseUrl ?? undefined}>{g.baseUrl ?? <span class="muted">Default</span>}</td>
                  <td title={g.keys.map((k) => k.masked).join('\n') || undefined}>{g.keys.length}</td>
                  <td title={g.models.map((m) => (m.alias ? `${m.alias} → ${m.name}` : m.name)).join('\n') || undefined}>
                    {g.models.length || <span class="muted">All</span>}
                  </td>
                  <td class="row-actions">
                    <button class="btn ghost icon-btn" title="Edit" onClick={() => setEditing({ target: { family: g.family, name: g.name }, group: g })}>
                      <Pencil size={ICON_PX} />
                    </button>
                    <button class="btn ghost icon-btn" title="Remove" onClick={() => setDeleting(g)}>
                      <Trash2 size={ICON_PX} />
                    </button>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>

      <Show when={editing()}>
        {(e) => (
          <ProviderDialog
            target={e().target}
            group={e().group}
            groups={groups()}
            onClose={() => setEditing(null)}
            onSaved={(next) => {
              setEditing(null);
              setError(null);
              mutate({ groups: next, error: null });
            }}
          />
        )}
      </Show>
      <Show when={deleting()}>
        {(g) => (
          <Dialog
            title="Remove provider?"
            onClose={() => setDeleting(null)}
            actions={
              <>
                <button class="btn" onClick={() => setDeleting(null)}>Cancel</button>
                <button class="btn danger" onClick={() => void remove(g())}>Remove</button>
              </>
            }
          >
            <p class="secondary">
              This removes <strong>{g().name}</strong> ({FAMILY_INFO[g().family].label}) and its {g().keys.length === 1 ? 'key' : 'keys'} from config.user.yaml.
            </p>
          </Dialog>
        )}
      </Show>
    </>
  );
}
