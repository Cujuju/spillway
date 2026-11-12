import type { ActivityPanelSpec } from '@shared/activityBoard';
import { emptyCounts } from '@shared/activityCounts';
import { parseComboKey, type CompareReport, type CompareRow } from '@shared/activityCompare';

/** A combination card on the board: its pinned combination, or none to show the next costliest. */
export interface ComboTile { id: string; combo?: string }

/** The combination cards in board order. */
export const comboTiles = (order: string[], panels: Record<string, ActivityPanelSpec | undefined>): ComboTile[] =>
  order.flatMap((id) => panels[id]?.kind === 'combo' ? [{ id, combo: panels[id].combo }] : []);

/** Each card's combination: its pinned one, else the costliest in range not on another card; null when none is left. */
export function resolveCombos(tiles: ComboTile[], ranked: readonly string[]): Map<string, string | null> {
  const pinned = new Set(tiles.flatMap((t) => (t.combo ? [t.combo] : [])));
  const spare = ranked.filter((k) => !pinned.has(k));
  return new Map(tiles.map((t) => [t.id, t.combo ?? spare.shift() ?? null]));
}

/** Shown combinations in board order, each once. */
export const shownCombos = (tiles: ComboTile[], resolved: Map<string, string | null>): string[] =>
  [...new Set(tiles.flatMap((t) => resolved.get(t.id) ?? []))];

/**
 * Once cards are added, removed or moved, pins every card to the combination it showed (`resolved`,
 * in the old board order), so the selection stays as the user left it.
 */
export function pinCombos(after: string[], panels: Record<string, ActivityPanelSpec>, resolved: Map<string, string | null>): Record<string, ActivityPanelSpec> {
  const before = [...resolved.keys()];
  const now = comboTiles(after, panels).map((t) => t.id);
  if (before.length === now.length && before.every((id, i) => id === now[i])) return panels;
  return Object.fromEntries(Object.entries(panels).map(([id, spec]) => {
    const shown = resolved.get(id);
    return [id, spec.kind === 'combo' && !spec.combo && shown ? { ...spec, combo: shown } : spec];
  }));
}

/** The baseline column: the chosen one when shown, else the first. */
export const baselineOf = (shown: string[], chosen: string | null): string | null =>
  chosen !== null && shown.includes(chosen) ? chosen : shown[0] ?? null;

/** Version parts are one or two digits, so a trailing snapshot date stays out of the version. */
const CLAUDE_ID = /^claude-([a-z]+)((?:-\d{1,2})+)(?:-\d{8})?$/;
/** "claude-fable-5-2" → "Fable 5.2"; other providers' IDs read fine as they are. */
export function modelName(id: string): string {
  const m = CLAUDE_ID.exec(id);
  return m ? `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]!.slice(1).replaceAll('-', '.')}` : id;
}

/** "Fable 5.2 · high". */
export function comboName(key: string): string {
  const c = parseComboKey(key);
  return c ? `${modelName(c.model)} · ${c.effort}` : key;
}

/** The report's figures for a combination; zeros for a pinned one with nothing in this range. */
export function comboRow(report: CompareReport | null | undefined, key: string): CompareRow {
  const found = report?.combos.find((c) => c.key === key);
  if (found) return found;
  const c = parseComboKey(key);
  return { key, model: c?.model ?? '', effort: c?.effort ?? '', whole: { ...emptyCounts(), promptTokens: 0 }, tasks: null, asSubagentCostUsd: 0 };
}
