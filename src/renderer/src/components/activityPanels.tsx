import type { TileSize } from '@cujuju/solidjs-tiling-window-manager';
import type { JSX } from 'solid-js';
import type { ActivityPanelKind, ActivityPanelSpec } from '@shared/activityBoard';
import type { ActivityBucket } from '@shared/types';
import { metricValue, type ModelRow, type SeriesPoint, type Summary } from '../lib/activityStats';
import { pct } from '../lib/format';
import { ActivityHeatmap } from './ActivityHeatmap';
import { axisMetric, countRows, formatMetric, metricLabel } from './activityFormat';
import type { TipRow } from './ChartTip';
import { ModelTable } from './ModelTable';
import { TrendChart } from './TrendChart';

/** The hit rate sits near 100% most of the time; 0/50/100% lines are enough. */
const CACHE_Y_TICKS = 2;

/** Everything the Overview's charts read, for the selected range. */
export interface ActivityData {
  points: () => SeriesPoint[];
  /** Every stored hour; the heatmap picks its own window. */
  rows: () => ActivityBucket[];
  now: () => number;
  models: () => ModelRow[];
  total: () => Summary;
  /** "Hourly", "Daily" … for the range. */
  bucketNote: () => string;
  xLabel: (t: number) => string;
  tip: (i: number) => { title: string; rows: TipRow[] };
}

interface PanelDef {
  title: (spec: ActivityPanelSpec) => string;
  note?: (data: ActivityData) => string;
  /** Shows the tile's API cost / Tokens / Requests switch. */
  hasMetric: boolean;
  /** Smallest tile that still reads: axis labels plus a few bars, or a header and two table rows. */
  minSize: TileSize;
  body: (spec: () => ActivityPanelSpec, data: ActivityData, tileId: string) => JSX.Element;
}

export const PANELS: Record<ActivityPanelKind, PanelDef> = {
  trend: {
    title: (spec) => `${metricLabel(spec.metric)} over time`,
    note: (data) => data.bucketNote(),
    hasMetric: true,
    minSize: { width: 360, height: 170 },
    body: (spec, data) => (
      <TrendChart kind="bar" ariaLabel={`${metricLabel(spec().metric)} over time`}
        points={data.points().map((p) => ({ start: p.start, value: metricValue(p.summary, spec().metric) }))}
        yLabel={axisMetric(spec().metric)} xLabel={data.xLabel} tooltip={data.tip} />
    ),
  },
  cache: {
    title: () => 'Cache hit rate',
    note: () => 'Share of prompt tokens read from cache',
    hasMetric: false,
    minSize: { width: 320, height: 150 },
    body: (_spec, data) => (
      <TrendChart kind="line" ariaLabel="Cache hit rate over time" yMax={1} yTicks={CACHE_Y_TICKS}
        points={data.points().map((p) => ({ start: p.start, value: p.summary.cacheHitRate }))}
        yLabel={(v) => pct(v * 100)} xLabel={data.xLabel} tooltip={data.tip} />
    ),
  },
  heatmap: {
    title: () => 'By hour',
    hasMetric: true,
    minSize: { width: 380, height: 260 },
    body: (spec, data, tileId) => (
      <ActivityHeatmap tileId={tileId} rows={data.rows()} now={data.now()} metric={spec().metric} format={(s) => formatMetric(spec().metric)(s)} tooltip={countRows} />
    ),
  },
  models: {
    title: () => 'Models',
    hasMetric: true,
    minSize: { width: 420, height: 170 },
    body: (spec, data) => <ModelTable models={data.models()} total={data.total()} metric={spec().metric} />,
  },
};

/** The "Add chart" menu: each over-time metric is its own choice. */
export const ADD_CHOICES: { label: string; spec: ActivityPanelSpec }[] = [
  { label: 'API cost over time', spec: { kind: 'trend', metric: 'cost' } },
  { label: 'Tokens over time', spec: { kind: 'trend', metric: 'tokens' } },
  { label: 'Requests over time', spec: { kind: 'trend', metric: 'requests' } },
  { label: 'Cache hit rate', spec: { kind: 'cache', metric: 'cost' } },
  { label: 'By hour', spec: { kind: 'heatmap', metric: 'cost' } },
  { label: 'Models', spec: { kind: 'models', metric: 'cost' } },
];
