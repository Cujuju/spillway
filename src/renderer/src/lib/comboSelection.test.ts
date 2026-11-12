import { describe, expect, it } from 'vitest';
import type { ActivityPanelSpec } from '@shared/activityBoard';
import { baselineOf, comboName, comboTiles, modelName, pinCombos, resolveCombos, shownCombos } from './comboSelection';
import { multiple, points } from './compareFormat';

const card = (combo?: string): ActivityPanelSpec => ({ kind: 'combo', metric: 'cost', ...(combo ? { combo } : {}) });
const panels: Record<string, ActivityPanelSpec> = { a: card(), b: card(), c: card(), t: { kind: 'trend', metric: 'cost' } };
const ranked = ['k1', 'k2', 'k3', 'k4'];

describe('combination selection', () => {
  it('fills unpinned cards with the costliest combinations, in board order', () => {
    const tiles = comboTiles(['t', 'b', 'a', 'c'], panels);
    expect(tiles.map((t) => t.id)).toEqual(['b', 'a', 'c']);
    expect([...resolveCombos(tiles, ranked)]).toEqual([['b', 'k1'], ['a', 'k2'], ['c', 'k3']]);
  });

  it('skips a pinned combination when filling the others, and runs out to null', () => {
    const resolved = resolveCombos(comboTiles(['a', 'b', 'c'], { ...panels, b: card('k1') }), ['k1', 'k2']);
    expect([...resolved]).toEqual([['a', 'k2'], ['b', 'k1'], ['c', null]]);
    expect(shownCombos(comboTiles(['a', 'b', 'c'], { ...panels, b: card('k1') }), resolved)).toEqual(['k2', 'k1']);
  });

  it('pins what each card showed once a card is removed, so the next costliest never slides in', () => {
    const resolved = resolveCombos(comboTiles(['a', 'b', 'c'], panels), ranked);
    const { b: _, ...rest } = panels;
    const pinned = pinCombos(['a', 'c'], rest, resolved);
    expect(pinned).toMatchObject({ a: { combo: 'k1' }, c: { combo: 'k3' } });
    expect(resolveCombos(comboTiles(['a', 'c'], pinned), ranked).get('c')).toBe('k3');
  });

  it('pins on a move too, but not when the cards keep their order', () => {
    const resolved = resolveCombos(comboTiles(['a', 'b', 'c'], panels), ranked);
    expect(pinCombos(['t', 'a', 'b', 'c'], panels, resolved)).toBe(panels);
    expect(pinCombos(['b', 'a', 'c'], panels, resolved)).toMatchObject({ a: { combo: 'k1' }, b: { combo: 'k2' } });
  });

  it('uses the chosen baseline only while it is shown', () => {
    expect(baselineOf(['k1', 'k2'], 'k2')).toBe('k2');
    expect(baselineOf(['k1', 'k2'], 'k9')).toBe('k1');
    expect(baselineOf([], null)).toBeNull();
  });

  it('names Claude models by family and version, leaving other IDs alone', () => {
    expect(modelName('claude-fable-5-2')).toBe('Fable 5.2');
    expect(modelName('claude-opus-5-5-20261001')).toBe('Opus 5.5');
    expect(modelName('gpt-6.1-sol')).toBe('gpt-6.1-sol');
    expect(comboName(JSON.stringify(['claude-opus-5-5', 'high']))).toBe('Opus 5.5 · high');
  });

  it('formats multiples and point differences', () => {
    expect(multiple(2.4567)).toBe('2.46×');
    expect(multiple(12.4)).toBe('12×');
    expect(points(1.44)).toBe('+1.4 pt');
    expect(points(-0.6)).toBe('−0.6 pt');
    expect(points(0)).toBe('0.0 pt');
  });
});
