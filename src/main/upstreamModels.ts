import { FAMILY_INFO, MODEL_LISTS, type ApiProviderTarget, type UpstreamModelsRequest } from '@shared/apiProviders';
import type { CredentialModel } from '@shared/types';

/** Long enough for a slow upstream, short enough that the editor never looks stuck. */
const MODEL_LIST_TIMEOUT_MS = 10_000;
/** Anthropic's largest page size; one page covers every model it serves. */
const ANTHROPIC_PAGE_LIMIT = 1000;
/** Version header Anthropic requires on every request. */
const ANTHROPIC_VERSION = '2023-06-01';

/** Models an API-key upstream serves, by id. `savedKey` resolves the edited group's key in the main process. */
export async function listUpstreamModels(req: UpstreamModelsRequest, savedKey: (target: NonNullable<ApiProviderTarget>) => string | null): Promise<CredentialModel[]> {
  const list = MODEL_LISTS[req.family];
  if (!list) throw new Error(`Spillway cannot read the model list of ${FAMILY_INFO[req.family].label} providers. Type the model names.`);
  const key = req.key?.trim() || (req.target ? savedKey(req.target) : null);
  if (!key && !FAMILY_INFO[req.family].keysOptional) throw new Error('Add an API key first.');
  const base = (req.baseUrl.trim() || list.defaultBaseUrl).replace(/\/+$/, '');
  if (!base) throw new Error('Enter the base URL first.');

  const url = list.style === 'anthropic' ? `${base}/v1/models?limit=${ANTHROPIC_PAGE_LIMIT}` : `${base}/models`;
  const headers: Record<string, string> = list.style === 'anthropic'
    ? { 'anthropic-version': ANTHROPIC_VERSION, ...(key ? { 'x-api-key': key } : {}) }
    : key ? { authorization: `Bearer ${key}` } : {};
  const host = new URL(url).host;
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`Could not reach ${host}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new Error(`${host} refused the model list (HTTP ${res.status}). Check the key and base URL.`);
  const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
  const byId = new Map<string, CredentialModel>();
  for (const item of Array.isArray(body?.data) ? (body.data as unknown[]) : []) {
    const m = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const id = text(m.id);
    // Anthropic names models in display_name; OpenAI-style lists give owned_by.
    if (id && !byId.has(id)) byId.set(id, { id, displayName: text(m.display_name), ownedBy: text(m.owned_by) });
  }
  if (byId.size === 0) throw new Error(`${host} listed no models.`);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
