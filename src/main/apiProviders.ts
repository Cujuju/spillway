import { createHash } from 'node:crypto';
import { Document, isMap, isSeq, parseDocument, YAMLMap, YAMLSeq } from 'yaml';
import {
  API_KEY_FAMILIES, validateDraft, type ApiKeyFamily, type ApiProviderDraft, type ApiProviderGroup, type ApiProviderTarget,
} from '@shared/apiProviders';

/** 64 bits of the key's hash: enough to tell a group's keys apart, too little to recover the key. */
const KEY_ID_HEX_CHARS = 16;
/** Characters shown at each end of a masked key; shorter keys show none. */
const MASK_EDGE_CHARS = 4;
const MIN_MASKED_EDGES_LENGTH = MASK_EDGE_CHARS * 3;
const ROOT = 'api-keys';
const CHANGED_ON_DISK = 'config.user.yaml changed since this was opened. Close the editor and try again.';

export const keyId = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, KEY_ID_HEX_CHARS);
export const maskKey = (key: string) =>
  key.length >= MIN_MASKED_EDGES_LENGTH ? `${key.slice(0, MASK_EDGE_CHARS)}…${key.slice(-MASK_EDGE_CHARS)}` : '••••';

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const keyOf = (node: unknown): string | null => (isMap(node) ? str(node.get('api-key')) : null);

/** Parses config.user.yaml for editing; throws its first error rather than rewriting a file the user broke. */
export function parseForEdit(text: string): Document {
  // Widened from Document.Parsed so new nodes can be inserted.
  const doc: Document = parseDocument(text);
  const [err] = doc.errors;
  if (err) throw new Error(`Fix config.user.yaml first: ${err.message.split('\n')[0] ?? err.message}`);
  if (doc.contents === null) doc.contents = doc.createNode({});
  if (!isMap(doc.contents)) throw new Error('Fix config.user.yaml first: it must be a mapping of keys');
  return doc;
}

/** Every group under `api-keys`, in file order. Entries without a name are skipped: the editor cannot address them. */
export function readGroups(doc: Document): ApiProviderGroup[] {
  const groups: ApiProviderGroup[] = [];
  for (const family of API_KEY_FAMILIES) {
    const seq = doc.getIn([ROOT, family]);
    if (!isSeq(seq)) continue;
    for (const item of seq.items) {
      if (!isMap(item)) continue;
      const name = str(item.get('name'));
      if (!name) continue;
      const keys = isSeq(item.get('keys')) ? (item.get('keys') as YAMLSeq).items.flatMap((node) => {
        const key = keyOf(node);
        return key ? [{ id: keyId(key), masked: maskKey(key), ...(isMap(node) && node.get('disabled') === true ? { disabled: true } : {}) }] : [];
      }) : [];
      const models = isSeq(item.get('models'))
        ? (item.get('models') as YAMLSeq).items.flatMap((m) => {
            const model = isMap(m) ? str(m.get('name')) : null;
            return model ? [{ name: model, alias: str((m as YAMLMap).get('alias')) }] : [];
          })
        : [];
      groups.push({
        family,
        name,
        baseUrl: str(item.get('base-url')),
        prefix: str(item.get('prefix')),
        disabled: item.get('disabled') === true,
        keys,
        models,
      });
    }
  }
  return groups;
}

function familySeq(doc: Document, family: ApiKeyFamily): YAMLSeq {
  const existing = doc.getIn([ROOT, family]);
  if (isSeq(existing)) return existing;
  const seq = new YAMLSeq();
  doc.setIn([ROOT, family], seq);
  return seq;
}

function findGroup(doc: Document, family: ApiKeyFamily, name: string): YAMLMap | null {
  const seq = doc.getIn([ROOT, family]);
  if (!isSeq(seq)) return null;
  return (seq.items.find((i) => isMap(i) && i.get('name') === name) as YAMLMap | undefined) ?? null;
}

/** Changes a key's routing state without removing its secret or per-key options. */
export function setKeyEnabled(doc: Document, family: ApiKeyFamily, name: string, id: string, enabled: boolean): void {
  const group = findGroup(doc, family, name);
  const keys = group?.get('keys');
  const node = isSeq(keys) ? keys.items.find((n) => { const k = keyOf(n); return k !== null && keyId(k) === id; }) : null;
  if (!isMap(node)) throw new Error(CHANGED_ON_DISK);
  setNodeEnabled(node, enabled);
}

function setNodeEnabled(node: YAMLMap, enabled: boolean): void {
  if (enabled) node.delete('disabled');
  else node.set('disabled', true);
}

/** A raw key for reading the upstream's model list (free, no routing), main-process only. Prefers an enabled key; a switched-off key still works. */
export function modelListKey(doc: Document, family: ApiKeyFamily, name: string): string | null {
  const keys = findGroup(doc, family, name)?.get('keys');
  if (!isSeq(keys)) return null;
  const usable = keys.items.filter((n) => keyOf(n) !== null);
  const node = usable.find((n) => !(isMap(n) && n.get('disabled') === true)) ?? usable[0];
  return node ? keyOf(node) : null;
}

/** Sets `key` to a trimmed value, or removes it when empty. */
function setOptional(group: YAMLMap, key: string, value: string): void {
  const v = value.trim();
  if (v) group.set(key, v);
  else group.delete(key);
}

/** Kept keys keep their per-key settings, in file order, switched on or off per `off`; new keys follow. */
function nextKeys(group: YAMLMap, keep: string[], off: string[], added: string[]): YAMLSeq {
  const saved = isSeq(group.get('keys')) ? (group.get('keys') as YAMLSeq).items : [];
  const savedIds = new Set(saved.map((n) => keyOf(n)).filter((k): k is string => k !== null).map(keyId));
  if (keep.some((id) => !savedIds.has(id))) throw new Error(CHANGED_ON_DISK);
  const seq = new YAMLSeq();
  const present = new Set<string>();
  for (const node of saved) {
    const k = keyOf(node);
    if (k && isMap(node) && keep.includes(keyId(k)) && !present.has(k)) {
      setNodeEnabled(node, !off.includes(keyId(k)));
      seq.add(node);
      present.add(k);
    }
  }
  for (const raw of added) {
    const k = raw.trim();
    if (k && !present.has(k)) {
      const node = new YAMLMap();
      node.set('api-key', k);
      seq.add(node);
      present.add(k);
    }
  }
  return seq;
}

/** Model rows by upstream name; a saved row keeps its other settings (thinking, context length…). */
function nextModels(group: YAMLMap, models: ApiProviderDraft['models']): YAMLSeq {
  const saved = isSeq(group.get('models')) ? (group.get('models') as YAMLSeq).items.filter(isMap) : [];
  const seq = new YAMLSeq();
  for (const m of models) {
    const name = m.name.trim();
    const node = saved.find((s) => s.get('name') === name) ?? new YAMLMap();
    node.set('name', name);
    setOptional(node, 'alias', m.alias ?? '');
    seq.add(node);
  }
  return seq;
}

/** Applies the editor's draft to `doc`: updates `target`, or adds a group when it is null. */
export function applyDraft(doc: Document, draft: ApiProviderDraft, target: ApiProviderTarget): void {
  const problem = validateDraft(draft, readGroups(doc), target);
  if (problem) throw new Error(problem);
  let group: YAMLMap;
  if (target) {
    const found = findGroup(doc, target.family, target.name);
    if (!found) throw new Error(CHANGED_ON_DISK);
    group = found;
  } else {
    group = new YAMLMap();
    familySeq(doc, draft.family).add(group);
  }
  group.set('name', draft.name.trim());
  setOptional(group, 'base-url', draft.baseUrl);
  setOptional(group, 'prefix', draft.prefix);
  if (draft.family === 'openai-compatibility' && draft.disabled) group.set('disabled', true);
  else group.delete('disabled');
  const keys = nextKeys(group, draft.keepKeys, draft.offKeys, draft.newKeys);
  if (keys.items.length) group.set('keys', keys);
  else group.delete('keys');
  const models = nextModels(group, draft.models);
  if (models.items.length) group.set('models', models);
  else group.delete('models');
}

/** Removes a group; drops the family list and the `api-keys` section once empty. */
export function removeGroup(doc: Document, family: ApiKeyFamily, name: string): void {
  const seq = doc.getIn([ROOT, family]);
  const index = isSeq(seq) ? seq.items.findIndex((i) => isMap(i) && i.get('name') === name) : -1;
  if (index < 0) throw new Error(CHANGED_ON_DISK);
  (seq as YAMLSeq).items.splice(index, 1);
  if ((seq as YAMLSeq).items.length === 0) doc.deleteIn([ROOT, family]);
  const root = doc.get(ROOT);
  if (isMap(root) && root.items.length === 0) doc.delete(ROOT);
}
