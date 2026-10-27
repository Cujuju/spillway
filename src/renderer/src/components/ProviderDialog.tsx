import { Plus, X } from 'lucide-solid';
import { createSignal, createUniqueId, For, Index, onMount, Show, untrack } from 'solid-js';
import {
  API_KEY_FAMILIES, FAMILY_INFO, MODEL_LISTS, validateDraft, type ApiKeyFamily, type ApiModelAlias, type ApiProviderGroup, type ApiProviderTarget,
} from '@shared/apiProviders';
import type { CredentialModel } from '@shared/types';
import { ModelFamilyList } from './ModelFamilyList';
import { Dialog, Notice, Toggle } from './ui';

const ICON_PX = 13;

/** Adds or edits one API-key group. Saved keys are shown masked and can only be kept or removed. */
export function ProviderDialog(props: {
  target: ApiProviderTarget;
  group: ApiProviderGroup | null;
  groups: ApiProviderGroup[];
  onClose: () => void;
  onSaved: (groups: ApiProviderGroup[]) => void;
}) {
  // Seeded once from the group being edited; the dialog owns the draft from here.
  const start = untrack(() => props.group);
  const [family, setFamily] = createSignal<ApiKeyFamily>(start?.family ?? 'openai-compatibility');
  const [name, setName] = createSignal(start?.name ?? '');
  const [baseUrl, setBaseUrl] = createSignal(start?.baseUrl ?? '');
  const [prefix, setPrefix] = createSignal(start?.prefix ?? '');
  const [disabled, setDisabled] = createSignal(start?.disabled ?? false);
  const [keepKeys, setKeepKeys] = createSignal(start?.keys.map((k) => k.id) ?? []);
  const [offKeys, setOffKeys] = createSignal(start?.keys.filter((k) => k.disabled).map((k) => k.id) ?? []);
  const [newKey, setNewKey] = createSignal('');
  const [newKeys, setNewKeys] = createSignal<string[]>([]);
  const [models, setModels] = createSignal<ApiModelAlias[]>(start?.models ?? []);
  const [error, setError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);

  const info = () => FAMILY_INFO[family()];
  const addKey = () => {
    const k = newKey().trim();
    if (k && !newKeys().includes(k)) setNewKeys([...newKeys(), k]);
    setNewKey('');
    if (k && !available().length) void loadModels();
  };
  const setModel = (i: number, patch: Partial<ApiModelAlias>) => setModels(models().map((m, j) => (j === i ? { ...m, ...patch } : m)));

  // The upstream's model list loads on open and whenever the type, base URL or key it depends on changes.
  const modelListId = createUniqueId();
  const [available, setAvailable] = createSignal<CredentialModel[]>([]);
  const [loadingModels, setLoadingModels] = createSignal(false);
  const [modelsError, setModelsError] = createSignal<string | null>(null);
  const listable = () => !!MODEL_LISTS[family()];
  // A typed or newly added key first; an edited group falls back to its saved key in the main process.
  const listKey = () => newKey().trim() || newKeys()[0] || null;
  const canList = () => listable() && (!!listKey() || !!props.target || info().keysOptional) && (!!baseUrl().trim() || !info().baseUrlRequired);
  let latestRequest = 0;
  const loadModels = async () => {
    const request = ++latestRequest;
    setModelsError(null);
    if (!canList()) return setAvailable([]);
    setLoadingModels(true);
    try {
      const list = await window.api.upstreamModels({ family: family(), baseUrl: baseUrl(), key: listKey(), target: props.target });
      if (request === latestRequest) setAvailable(list);
    } catch (e) {
      if (request === latestRequest) {
        setAvailable([]);
        setModelsError((e as Error).message);
      }
    } finally {
      if (request === latestRequest) setLoadingModels(false);
    }
  };
  onMount(() => void loadModels());
  const isPicked = (id: string) => models().some((m) => m.name.trim() === id);
  const togglePick = (id: string) =>
    setModels(isPicked(id) ? models().filter((m) => m.name.trim() !== id) : [...models(), { name: id, alias: null }]);

  const save = async () => {
    // A key typed but not yet added with + is still meant to be saved.
    const pending = newKey().trim();
    const draft = {
      family: family(),
      name: name(),
      baseUrl: baseUrl(),
      prefix: prefix(),
      disabled: disabled(),
      keepKeys: keepKeys(),
      offKeys: offKeys().filter((id) => keepKeys().includes(id)),
      newKeys: pending ? [...newKeys(), pending] : newKeys(),
      models: models().map((m) => ({ name: m.name.trim(), alias: m.alias?.trim() || null })),
    };
    const problem = validateDraft(draft, props.groups, props.target);
    if (problem) return setError(problem);
    setSaving(true);
    setError(null);
    try {
      props.onSaved(await window.api.saveApiProvider(draft, props.target));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      title={props.target ? `Edit ${props.target.name}` : 'Add provider'}
      onClose={props.onClose}
      actions={
        <>
          <button class="btn" onClick={props.onClose}>Cancel</button>
          <button class="btn primary" disabled={saving()} onClick={() => void save()}>Save</button>
        </>
      }
    >
      <div class="form">
        <label class="form-field">
          <span>Type</span>
          <select class="select" value={family()} disabled={!!props.target} onChange={(e) => { setFamily(e.currentTarget.value as ApiKeyFamily); void loadModels(); }}>
            <For each={API_KEY_FAMILIES}>{(f) => <option value={f}>{FAMILY_INFO[f].label}</option>}</For>
          </select>
          <span class="form-help">{info().hint}</span>
        </label>
        <label class="form-field">
          <span>Name</span>
          <input class="input" value={name()} placeholder="e.g. openrouter" onInput={(e) => setName(e.currentTarget.value)} />
        </label>
        <label class="form-field">
          <span>Base URL{info().baseUrlRequired ? '' : ' (optional)'}</span>
          <input class="input" value={baseUrl()} placeholder={info().baseUrlRequired ? 'https://…/v1' : 'Provider default'} onInput={(e) => setBaseUrl(e.currentTarget.value)} onChange={() => void loadModels()} />
        </label>
        <label class="form-field">
          <span>Prefix (optional)</span>
          <input class="input" value={prefix()} placeholder="none" onInput={(e) => setPrefix(e.currentTarget.value)} />
          <span class="form-help">Set one to reach these keys only through models named prefix/model.</span>
        </label>

        <div class="form-field">
          <span>API keys{info().keysOptional ? ' (optional)' : ''}</span>
          <For each={props.group?.keys.filter((k) => keepKeys().includes(k.id)) ?? []}>
            {(k) => (
              <div class="form-list-row">
                <span class="spacer">{k.masked}</span>
                <Toggle
                  value={!offKeys().includes(k.id)}
                  label={`Use key ${k.masked}`}
                  onChange={(on) => setOffKeys(on ? offKeys().filter((id) => id !== k.id) : [...offKeys(), k.id])}
                />
                <button class="btn ghost icon-btn" title="Remove key" onClick={() => setKeepKeys(keepKeys().filter((id) => id !== k.id))}>
                  <X size={ICON_PX} />
                </button>
              </div>
            )}
          </For>
          <For each={newKeys()}>
            {(k) => (
              <div class="form-list-row">
                <span class="spacer">New key ending {k.slice(-4)}</span>
                <button class="btn ghost icon-btn" title="Remove key" onClick={() => setNewKeys(newKeys().filter((x) => x !== k))}>
                  <X size={ICON_PX} />
                </button>
              </div>
            )}
          </For>
          <div class="form-list-row">
            <input class="input spacer" type="password" autocomplete="off" value={newKey()} placeholder="Paste a key" onInput={(e) => setNewKey(e.currentTarget.value)} onChange={() => !available().length && void loadModels()} onKeyDown={(e) => e.key === 'Enter' && addKey()} />
            <button class="btn ghost icon-btn" title="Add key" onClick={addKey}><Plus size={ICON_PX} /></button>
          </div>
        </div>

        <div class="form-field">
          <span>Models (optional)</span>
          <span class="form-help">
            Empty serves the provider's own model list. An alias is the name clients ask for.
            {listable() ? ' Click a model below to add or remove it.' : ''}
          </span>
          {/* Index, not For: each edit replaces the row's object, and For would remount the row and drop focus. */}
          <Index each={models()}>
            {(m, i) => (
              <div class="form-list-row">
                <input class="input spacer" list={modelListId} value={m().name} placeholder="Upstream model" onInput={(e) => setModel(i, { name: e.currentTarget.value })} />
                <input class="input spacer" value={m().alias ?? ''} placeholder="Alias (optional)" onInput={(e) => setModel(i, { alias: e.currentTarget.value })} />
                <button class="btn ghost icon-btn" title="Remove model" onClick={() => setModels(models().filter((_, j) => j !== i))}>
                  <X size={ICON_PX} />
                </button>
              </div>
            )}
          </Index>
          <datalist id={modelListId}>
            <For each={available()}>{(m) => <option value={m.id} />}</For>
          </datalist>
          <div class="form-list-row">
            <button class="btn ghost" onClick={() => setModels([...models(), { name: '', alias: null }])}><Plus size={ICON_PX} /> Add model</button>
          </div>
          <Show when={listable()}>
            <Show when={!modelsError()} fallback={
              <Notice tone="error">
                <span class="spacer">{modelsError()}</span>
                <button class="btn" onClick={() => void loadModels()}>Retry</button>
              </Notice>
            }>
              <Show when={!loadingModels()} fallback={<p class="form-help">Loading the provider's models…</p>}>
                <Show when={available().length} fallback={<Show when={!canList()}><p class="form-help">{info().baseUrlRequired && !baseUrl().trim() ? 'Enter the base URL' : 'Add a key'} to see the provider's models.</p></Show>}>
                  <ModelFamilyList models={available()} provider={FAMILY_INFO[family()].glyph} picked={isPicked} onPick={togglePick} />
                </Show>
              </Show>
            </Show>
          </Show>
        </div>

        <Show when={family() === 'openai-compatibility'}>
          <div class="form-list-row">
            <span class="spacer">Enabled</span>
            <Toggle value={!disabled()} label="Enabled" onChange={(on) => setDisabled(!on)} />
          </div>
        </Show>
        <p class="form-help">Saved to config.user.yaml and applied to the running proxy. Keys are stored there in plain text.</p>
        <Show when={error()}>
          <Notice tone="error">{error()}</Notice>
        </Show>
      </div>
    </Dialog>
  );
}
