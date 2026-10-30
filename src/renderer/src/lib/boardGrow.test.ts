import { describe, expect, it } from 'vitest';
import { appendRow } from './boardGrow';

describe('appendRow', () => {
  it('starts a board with the tile alone', () => {
    expect(appendRow(undefined, 'a', 500, 300)).toEqual({ kind: 'tile', id: 'a' });
  });

  it('wraps a single tile or row in a column so the old content keeps its height', () => {
    const next = appendRow({ kind: 'tile', id: 'a' }, 'b', 500, 300);
    expect(next).toEqual({ kind: 'split', dir: 'column', sizes: [500, 300], children: [{ kind: 'tile', id: 'a' }, { kind: 'tile', id: 'b' }] });
  });

  it('extends a column with a share sized to the added pixels', () => {
    const tree = { kind: 'split' as const, dir: 'column' as const, sizes: [1, 1], children: [{ kind: 'tile' as const, id: 'a' }, { kind: 'tile' as const, id: 'b' }] };
    const next = appendRow(tree, 'c', 400, 200);
    expect(next.kind === 'split' && next.sizes).toEqual([1, 1, 1]);
    // 400px of old rows + 200px new = 600px: each row 200px.
  });
});
