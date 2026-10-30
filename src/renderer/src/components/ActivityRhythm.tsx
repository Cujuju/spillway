import { Moon, Sun, Sunrise, Sunset } from 'lucide-solid';
import { createMemo, For } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import type { ActivityBucket } from '@shared/types';
import { metricValue, rhythmStats, type Metric, type Summary } from '../lib/activityStats';
import '../styles/rhythm.css';

const BAND_ICONS = { Morning: Sunrise, Afternoon: Sun, Evening: Sunset, Night: Moon };

export function ActivityRhythm(props: { rows: ActivityBucket[]; now: number; metric: Metric; format: (s: Summary) => string }) {
  const stats = createMemo(() => rhythmStats(props.rows, props.metric, props.now));
  const range = (band: { startHour: number; endHour: number }) => `${band.startHour}–${band.endHour}h`;
  return (
    <div class="rhythm">
      <div class="rhythm-bands">
        <For each={stats().bands}>{(band) => (
          <div class="rhythm-band" classList={{ peak: stats().peak?.name === band.name }}>
            <Dynamic component={BAND_ICONS[band.name]} class="rhythm-icon" aria-hidden="true" />
            <span>{band.name}<small>{range(band)}</small></span>
            <div class="rhythm-bar"><span style={{ width: `${stats().max > 0 ? metricValue(band.summary, props.metric) / stats().max * 100 : 0}%` }} /></div>
            <strong>{props.format(band.summary)}</strong>
          </div>
        )}</For>
      </div>
      <div class="rhythm-footer">
        <span>Peak: <strong>{stats().peak?.name ?? '—'}</strong></span>
        <span title="Calendar span from the earliest stored hourly activity through today">{stats().days}d · {props.format(stats().total)} total</span>
      </div>

    </div>
  );
}
