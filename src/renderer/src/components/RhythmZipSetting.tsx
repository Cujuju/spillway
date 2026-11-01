import { Show } from 'solid-js';
import { now, settings, updateSettings } from '../store';
import { createRhythmZipDraft } from '../lib/rhythmZipDraft';
import { createZipSunTimes, type SunTimes } from '../lib/solarTimes';

const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const HELP = 'Optional US ZIP code for sunrise and sunset, looked up on this machine; it is never sent anywhere. '
  + 'Leaving it blank keeps Rhythm at 6 AM and 6 PM.';

const clockLabel = (hour: number) =>
  new Date(2000, 0, 1, 0, Math.round(hour * MINUTES_PER_HOUR)).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

function describe(times: SunTimes) {
  if (times.sunset - times.sunrise === HOURS_PER_DAY) return 'Today the sun stays up all day.';
  if (times.sunset === times.sunrise) return 'Today the sun stays down all day.';
  return `Today: sunrise ${clockLabel(times.sunrise)}, sunset ${clockLabel(times.sunset)}.`;
}

export function RhythmZipSetting() {
  const stored = () => settings().activity.zipCode;
  const { draft, error, edit, save } = createRhythmZipDraft(
    stored,
    (zip) => updateSettings((d) => { d.activity.zipCode = zip; }),
  );
  // The store's clock ticks each minute, so the times follow the date through the year.
  const sunTimes = createZipSunTimes(stored, now);
  const saved = () => draft().trim() === stored() && !error();
  return (
    <div class="list-row">
      <div class="list-row-text">
        <div class="list-row-label">Rhythm ZIP code</div>
        <div class="list-row-help">{HELP}</div>
        <Show when={saved() && sunTimes()}>{(times) => <div class="list-row-help">{describe(times())}</div>}</Show>
      </div>
      <div class="list-row-actions">
        <div class="field-with-error">
          <input class="input short-field tabular" aria-label="Rhythm ZIP code" inputmode="numeric" autocomplete="postal-code"
            aria-invalid={!!error()} aria-describedby="rhythm-zip-error" value={draft()}
            onInput={(e) => edit(e.currentTarget.value)}
            onBlur={() => void save()} onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} />
          <Show when={error()}><div id="rhythm-zip-error" class="move-conversation-error" role="alert">{error()}</div></Show>
        </div>
      </div>
    </div>
  );
}
