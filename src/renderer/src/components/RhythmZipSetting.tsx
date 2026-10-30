import { createEffect, createSignal, Show } from 'solid-js';
import { settings, updateSettings } from '../store';
import { zipCoordinates } from '../lib/zipCoordinates';
import { SettingRow } from './ui';

export function RhythmZipSetting() {
  const [draft, setDraft] = createSignal('');
  const [error, setError] = createSignal('');
  let revision = 0;
  createEffect(() => { setDraft(settings().activity.zipCode); setError(''); revision++; });
  const save = async () => {
    const zip = draft().trim();
    const current = ++revision;
    if (zip && !/^\d{5}$/.test(zip)) { setError('Enter a 5-digit US ZIP code.'); return; }
    try {
      if (zip && !await zipCoordinates(zip)) {
        if (current === revision) setError('ZIP code not found in the Census ZCTA data.');
        return;
      }
      if (current !== revision) return;
      setError('');
      await updateSettings((d) => { d.activity.zipCode = zip; });
    } catch {
      if (current === revision) setError('Could not load ZIP code data. Try again.');
    }
  };
  return (
    <SettingRow label="Rhythm ZIP code" help="Optional US ZIP code for sunrise and sunset. Leaving it blank keeps Rhythm at 6 AM and 6 PM.">
      <div>
        <input class="input" aria-label="Rhythm ZIP code" inputmode="numeric" autocomplete="postal-code"
          aria-invalid={!!error()} aria-describedby="rhythm-zip-error" value={draft()}
          onInput={(e) => { revision++; setDraft(e.currentTarget.value); setError(''); }}
          onBlur={() => void save()} onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} />
        <Show when={error()}><div id="rhythm-zip-error" class="move-conversation-error" role="alert">{error()}</div></Show>
      </div>
    </SettingRow>
  );
}
