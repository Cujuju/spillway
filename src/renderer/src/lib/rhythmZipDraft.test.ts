import { createRoot, createSignal, untrack } from 'solid-js';
import { expect, it } from 'vitest';
import { createRhythmZipDraft } from './rhythmZipDraft';

it('preserves edits newer than a deferred save acknowledgement', async () => {
  const [stored, setStored] = createSignal('');
  let resolve!: () => void;
  const pending = new Promise<void>((done) => { resolve = done; });
  let started!: () => void;
  const saving = new Promise<void>((done) => { started = done; });
  const { state, dispose } = createRoot((dispose) => ({ dispose, state: createRhythmZipDraft(stored, async (zip) => {
    started();
    await pending;
    setStored(zip);
  }) }));
  try {
    state.edit('90210');
    const save = state.save();
    await saving;
    state.edit('10001');
    resolve();
    await save;
    expect(untrack(stored)).toBe('90210');
    expect(state.draft()).toBe('10001');
    await state.save();
    expect(untrack(stored)).toBe('10001');
    expect(state.draft()).toBe('10001');
    setStored('00601');
    expect(state.draft()).toBe('00601');
  } finally { dispose(); }
});

it('warns about an unknown stored ZIP without an edit', async () => {
  const { state, dispose } = createRoot((dispose) => ({ dispose, state: createRhythmZipDraft(() => '00000', async () => {}) }));
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.draft()).toBe('00000');
    expect(state.error()).toContain('not found');
  } finally { dispose(); }
});
