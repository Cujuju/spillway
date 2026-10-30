import { createMemo } from 'solid-js';
import type { ActivityBucket } from '@shared/types';
import { hourLabel, hourlySeries, metricValue, type Metric } from '../lib/activityStats';
import { axisMetric, countRows } from './activityFormat';
import { TrendChart } from './TrendChart';

export function ActivityHourly(props: { rows: ActivityBucket[]; now: number; metric: Metric }) {
  const points = createMemo(() => hourlySeries(props.rows, props.now));
  return (
    <TrendChart kind="bar" ariaLabel="Hourly activity"
      points={points().map((p) => ({ start: p.start, value: metricValue(p.summary, props.metric) }))}
      yLabel={axisMetric(props.metric)} xLabel={(t) => hourLabel(new Date(t).getHours())}
      tooltip={(i) => ({
        title: new Date(points()[i]!.start).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', timeZoneName: 'short' }),
        rows: countRows(points()[i]!.summary),
      })} />
  );
}
