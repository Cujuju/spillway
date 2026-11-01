import { HoverTip } from '../components/ChartTip';
import { Pencil, Plus, Trash2 } from 'lucide-solid';
import { createResource, createSignal, For, Show } from 'solid-js';
import { FAMILY_INFO, type ApiProviderGroup, type ApiProviderTarget } from '@shared/apiProviders';
import { LoginsSection } from '../components/LoginsSection';
import { ProviderDialog } from '../components/ProviderDialog';
import { Dialog, Notice, ProviderGlyph, Toggle } from '../components/ui';
import { providerVar } from '../lib/providers';
import { PageHeader } from '../components/PageHeader';

const ICON_PX = 14;

/** Everything the proxy routes to: signed-in logins, then API-key upstreams from config.user.yaml's `api-keys` section. */
export function Providers() {
  const [list, { mutate, refetch }] = createResource(() => window.api.apiProviders());
  const [editing, setEditing] = createSignal<{ target: ApiProviderTarget; group: ApiProviderGroup | null } | null>(null);
  const [deleting, setDeleting] = createSignal<ApiProviderGroup | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [toggling, setToggling] = createSignal(false);
  const groups = () => list()?.groups ?? [];
  const fileError = () => list()?.error ?? null;

  const toggleKey = async (g: ApiProviderGroup, id: string, enabled: boolean) => {
    setToggling(true);
    setError(null);
    try {
      mutate({ groups: await window.api.setApiKeyEnabled(g.family, g.name, id, enabled), error: null });
    } catch (e) {
      setError((e as Error).message);
      void refetch();
    } finally {
      setToggling(false);
    }
  };

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
      <PageHeader>
        <div>
          <h1 class="dash-title">AI Providers</h1>
          <div class="dash-sub">Signed-in accounts and API keys the proxy routes requests to</div>
        </div>
      </PageHeader>

      <LoginsSection />

      <section class="page-section">
        <div class="section-head">
          <div class="spacer">
            <h2 class="card-title">API keys</h2>
            <div class="list-row-help">API-key upstreams and OpenAI-compatible endpoints, saved in config.user.yaml</div>
          </div>
          <div class="dash-actions">
            <button class="btn" title="Every custom proxy setting, providers included" onClick={() => void window.api.openPath('userConfig')}>
              Open config.user.yaml
            </button>
            <button class="btn primary" disabled={!!fileError()} onClick={() => setEditing({ target: null, group: null })}>
              <Plus size={ICON_PX} /> Add provider
            </button>
          </div>
        </div>

        <Show when={fileError()}>
          <Notice tone="error">
            <span class="spacer">{fileError()}</span>
            <button class="btn" onClick={() => void refetch()}>Reload</button>
          </Notice>
        </Show>
        <Show when={error()}>
          <Notice tone="error">{error()}</Notice>
        </Show>

        <div class="card flush">
          <table class="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Endpoint</th>
                <th>Keys</th>
                <th>Models</th>
                <th class="col-enabled">Enabled</th>
                <th class="row-actions" />
              </tr>
            </thead>
            <tbody>
              <For
                each={groups()}
                fallback={
                  <tr>
                    <td colSpan={7} class="muted empty-row">
                      {list.loading ? 'Loading…' : 'No API keys yet. Use “Add provider” to add one.'}
                    </td>
                  </tr>
                }
              >
                {(g) => (
                  <tr class="card-wash" classList={{ disabled: g.disabled }} style={{ '--card-wash-hue': providerVar(FAMILY_INFO[g.family].glyph) }}>
                    <td class="fill">
                      <div class="row">
                        <ProviderGlyph provider={FAMILY_INFO[g.family].glyph} />
                        <span class="truncate" title={g.name}>{g.name}</span>
                        <Show when={g.disabled}><span class="badge">Off</span></Show>
                      </div>
                    </td>
                    <td class="nowrap">{FAMILY_INFO[g.family].label}</td>
                    <td class="truncate fill" title={g.baseUrl ?? undefined}>{g.baseUrl ?? <span class="muted">Default</span>}</td>
                    <td>
                      <div class="key-list">
                        <For each={g.keys} fallback={<span class="muted">No key</span>}>
                          {(k) => <span class="tabular nowrap">{k.masked}</span>}
                        </For>
                      </div>
                    </td>
                    <td>
                      <Show when={g.models.length} fallback={<span class="muted">All</span>}>
                        <HoverTip title="Provider models" rows={[
                          { label: 'Count', value: g.models.length.toLocaleString() },
                          ...g.models.map((m) => ({ label: m.alias || m.name, value: m.name })),
                        ]}>{g.models.length}</HoverTip>
                      </Show>
                    </td>
                    <td class="col-enabled">
                      <div class="key-list">
                        <For each={g.keys}>
                          {(k) => (
                            <Toggle value={!k.disabled} disabled={toggling() || !!fileError()} label={`Use key ${k.masked}`} onChange={(enabled) => void toggleKey(g, k.id, enabled)} />
                          )}
                        </For>
                      </div>
                    </td>
                    <td class="row-actions">
                      <div class="row-actions-bar">
                        <button class="btn ghost icon-btn" title="Edit" onClick={() => setEditing({ target: { family: g.family, name: g.name }, group: g })}>
                          <Pencil size={ICON_PX} />
                        </button>
                        <button class="btn ghost icon-btn" title="Remove" onClick={() => setDeleting(g)}>
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
      </section>

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
