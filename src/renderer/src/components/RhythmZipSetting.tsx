import { Show } from 'solid-js';
import { settings, updateSettings } from '../store';
import { createRhythmZipDraft } from '../lib/rhythmZipDraft';
import { SettingRow } from './ui';

export function RhythmZipSetting() {
  const { draft, error, edit, save } = createRhythmZipDraft(
    () => settings().activity.zipCode,
    (zip) => updateSettings((d) => { d.activity.zipCode = zip; }),
  );
  return (
    <SettingRow label="Rhythm ZIP code" help="Optional US ZIP code for sunrise and sunset. Leaving it blank keeps Rhythm at 6 AM and 6 PM.">
      <div>
        <input class="input" aria-label="Rhythm ZIP code" inputmode="numeric" autocomplete="postal-code"
          aria-invalid={!!error()} aria-describedby="rhythm-zip-error" value={draft()}
          onInput={(e) => edit(e.currentTarget.value)}
          onBlur={() => void save()} onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} />
        <Show when={error()}><div id="rhythm-zip-error" class="move-conversation-error" role="alert">{error()}</div></Show>
      </div>
    </SettingRow>
  );
}
