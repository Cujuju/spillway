import { createEffect, createSignal, onCleanup } from 'solid-js';
import { zipCoordinates } from './zipCoordinates';

export function createRhythmZipDraft(stored: () => string, persist: (zip: string) => Promise<void>) {
  const [draft, setDraft] = createSignal('');
  const [error, setError] = createSignal('');
  let revision = 0;
  let dirty = false;
  onCleanup(() => { revision++; });
  const validate = async (zip: string): Promise<string> => {
    if (!zip) return '';
    if (!/^\d{5}$/.test(zip)) return 'Enter a 5-digit US ZIP code.';
    return await zipCoordinates(zip) ? '' : 'ZIP code not found in the Census ZCTA data.';
  };
  createEffect(() => {
    const zip = stored();
    if (dirty) return;
    setDraft(zip);
    setError('');
    const current = ++revision;
    void validate(zip).then((message) => {
      if (current === revision) setError(message);
    }).catch(() => {
      if (current === revision) setError('Could not load ZIP code data. Try again.');
    });
  });
  const save = async () => {
    const zip = draft().trim();
    const current = ++revision;
    try {
      const message = await validate(zip);
      if (current !== revision) return;
      if (message) { setError(message); return; }
      setError('');
      await persist(zip);
      if (current === revision && stored() === zip) {
        dirty = false;
        setDraft(zip);
      }
    } catch {
      if (current === revision) setError('Could not load ZIP code data. Try again.');
    }
  };
  const edit = (value: string) => { dirty = true; revision++; setDraft(value); setError(''); };
  return { draft, error, edit, save };
}
