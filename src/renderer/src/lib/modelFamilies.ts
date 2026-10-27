import type { CredentialModel } from '@shared/types';

/**
 * Anthropic's tiers, most capable first. No proxy field ranks models, so this order is kept by hand.
 * Families named here lead in this order; the rest follow alphabetically.
 */
export const FAMILY_TIERS = ['fable', 'opus', 'sonnet', 'haiku'];

/** Snapshot date some IDs end with, e.g. `-20251101`. */
const DATE_SUFFIX = /-\d{8}$/;
/** An ID part that is a version: `5`, `4`, or `5.1`. */
const VERSION_PART = /^\d+(\.\d+)*$/;

export interface ModelVersion {
  model: CredentialModel;
  /** Version numbers in ID order: `claude-opus-4-5` → [4, 5]. Empty when the ID has none. */
  version: number[];
  /** `4.5`, or the ID when it has no version. */
  label: string;
  date: string;
}

export interface ModelFamily {
  /** The ID without its version and date: `claude-opus`. */
  key: string;
  latest: ModelVersion;
  /** Earlier versions, newest first. */
  older: ModelVersion[];
}

function parse(model: CredentialModel): ModelVersion & { key: string; words: string[] } {
  const date = model.id.match(DATE_SUFFIX)?.[0].slice(1) ?? '';
  const parts = (date ? model.id.slice(0, -date.length - 1) : model.id).split('-');
  const words = parts.filter((p) => !VERSION_PART.test(p));
  const version = parts.filter((p) => VERSION_PART.test(p)).flatMap((p) => p.split('.').map(Number));
  return { model, version, label: version.length ? version.join('.') : model.id, date, key: words.join('-'), words };
}

/** Below any real version part, so 5.5 sorts above 5. */
const NO_PART = -1;

/** Newest first: higher version, then the later snapshot date. */
function newestFirst(a: ModelVersion, b: ModelVersion): number {
  for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
    const d = (b.version[i] ?? NO_PART) - (a.version[i] ?? NO_PART);
    if (d) return d;
  }
  return b.date.localeCompare(a.date) || a.model.id.localeCompare(b.model.id);
}

const tierRank = (words: string[]) => {
  const i = FAMILY_TIERS.findIndex((t) => words.includes(t));
  return i === -1 ? FAMILY_TIERS.length : i;
};

/** Groups models by family (ID minus version and date): tiers first, then alphabetical; each family newest first. */
export function groupModelFamilies(models: CredentialModel[]): ModelFamily[] {
  const groups = new Map<string, { words: string[]; versions: [ModelVersion, ...ModelVersion[]] }>();
  for (const m of models) {
    const { key, words, ...v } = parse(m);
    const group = groups.get(key);
    if (group) group.versions.push(v);
    else groups.set(key, { words, versions: [v] });
  }
  return [...groups.entries()]
    .sort(([ka, a], [kb, b]) => tierRank(a.words) - tierRank(b.words) || ka.localeCompare(kb))
    .map(([key, g]) => {
      const [latest, ...older] = g.versions.sort(newestFirst);
      return { key, latest, older };
    });
}
