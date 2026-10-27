/** API-key upstreams: the proxy's v8 `api-keys` section, edited in config.user.yaml. */

/** Provider families v8 accepts under `api-keys` (config_v8.go v8KeyFamilies). */
export const API_KEY_FAMILIES = ['claude', 'codex', 'gemini', 'vertex', 'interactions', 'xai', 'meta', 'openai-compatibility'] as const;
export type ApiKeyFamily = (typeof API_KEY_FAMILIES)[number];

export const FAMILY_INFO: Record<ApiKeyFamily, { label: string; glyph: string; baseUrlRequired: boolean; keysOptional: boolean; hint: string }> = {
  claude: { label: 'Claude API', glyph: 'claude', baseUrlRequired: false, keysOptional: false, hint: 'Anthropic API keys; leave the URL empty for api.anthropic.com' },
  codex: { label: 'Codex API', glyph: 'codex', baseUrlRequired: false, keysOptional: false, hint: 'OpenAI API keys for Codex models' },
  gemini: { label: 'Gemini API', glyph: 'gemini', baseUrlRequired: false, keysOptional: false, hint: 'Google AI Studio keys' },
  vertex: { label: 'Vertex', glyph: 'gemini', baseUrlRequired: false, keysOptional: false, hint: 'Vertex-compatible endpoints; empty URL uses Google Vertex' },
  interactions: { label: 'Gemini Interactions', glyph: 'gemini', baseUrlRequired: false, keysOptional: false, hint: 'Keys used only for the native /v1beta/interactions API' },
  xai: { label: 'xAI API', glyph: 'xai', baseUrlRequired: false, keysOptional: false, hint: 'xAI API keys' },
  meta: { label: 'Muse (Meta) API', glyph: 'meta', baseUrlRequired: false, keysOptional: false, hint: 'Meta API keys; empty URL uses api.meta.ai' },
  'openai-compatibility': { label: 'OpenAI-compatible', glyph: 'openai-compatibility', baseUrlRequired: true, keysOptional: true, hint: 'Any OpenAI-style endpoint (OpenRouter, a local server, …)' },
};

/** A saved key as the renderer sees it: never the key itself. */
export interface ApiKeyRef {
  /** Stable fingerprint of the key, used to keep it on save. */
  id: string;
  masked: string;
  disabled?: boolean;
}

export interface ApiModelAlias {
  /** Upstream model name. */
  name: string;
  /** Name clients ask for; null exposes the upstream name. */
  alias: string | null;
}

export interface ApiProviderGroup {
  family: ApiKeyFamily;
  name: string;
  baseUrl: string | null;
  prefix: string | null;
  /** Only OpenAI-compatible groups can be switched off without removing them. */
  disabled: boolean;
  keys: ApiKeyRef[];
  models: ApiModelAlias[];
}

/** What the editor saves. Fields the editor does not show are kept as they are in the file. */
export interface ApiProviderDraft {
  family: ApiKeyFamily;
  name: string;
  baseUrl: string;
  prefix: string;
  disabled: boolean;
  /** Ids of saved keys to keep; saved keys not listed are removed. */
  keepKeys: string[];
  newKeys: string[];
  models: ApiModelAlias[];
}

export interface ApiProviderList {
  groups: ApiProviderGroup[];
  /** Set when config.user.yaml cannot be parsed; editing is refused until it is fixed. */
  error: string | null;
}

/** Identifies the group being edited; null adds a new one. */
export type ApiProviderTarget = { family: ApiKeyFamily; name: string } | null;

const isHttpUrl = (s: string) => {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

/** The first problem with a draft, or null. `groups` are the saved groups; `target` is the one being edited. */
export function validateDraft(draft: ApiProviderDraft, groups: ApiProviderGroup[], target: ApiProviderTarget): string | null {
  if (!API_KEY_FAMILIES.includes(draft.family)) return 'Choose a provider type.';
  if (target && target.family !== draft.family) return 'The provider type of a saved group cannot change.';
  const name = draft.name.trim();
  if (!name) return 'Enter a name.';
  if (groups.some((g) => g.family === draft.family && g.name === name && !(target && target.name === name))) return `A ${FAMILY_INFO[draft.family].label} group named "${name}" already exists.`;
  const url = draft.baseUrl.trim();
  if (!url && FAMILY_INFO[draft.family].baseUrlRequired) return 'Enter the base URL.';
  if (url && !isHttpUrl(url)) return 'The base URL must start with http:// or https://.';
  if (/\s/.test(draft.prefix.trim())) return 'The prefix cannot contain spaces.';
  // A keyless OpenAI-compatible group is registered by its URL (a local server); other families need a key.
  const keyCount = draft.keepKeys.length + draft.newKeys.filter((k) => k.trim()).length;
  if (keyCount === 0 && !FAMILY_INFO[draft.family].keysOptional) return 'Add at least one API key.';
  if (draft.models.some((m) => !m.name.trim())) return 'Every model row needs an upstream model name.';
  return null;
}
