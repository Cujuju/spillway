import type { TileSize } from '@cujuju/solidjs-tiling-window-manager';
import type { JSX } from 'solid-js';
import type { ActivityPanelKind, ActivityPanelSpec } from '@shared/activityBoard';
import { accountKey, clientKey } from '@shared/activityScope';
import { clientLabel } from '../lib/accountScope';
import type { ActivityBucket } from '@shared/types';
import { metricValue, type AccountRow, type ClientRow, type ModelRow, type SeriesPoint, type Summary } from '../lib/activityStats';
import { settings } from '../store';
import { pct } from '../lib/format';
import type { Span } from '../lib/activityRange';
import { ActivityHeatmap } from './ActivityHeatmap';
import { ActivityRhythm } from './ActivityRhythm';
import { axisMetric, countRows, formatMetric, metricLabel } from './activityFormat';
import type { TipRow } from './ChartTip';
import { BreakdownTable } from './BreakdownTable';
import { TrendChart } from './TrendChart';

/** The hit rate sits near 100% most of the time; 0/50/100% lines are enough. */
const CACHE_Y_TICKS = 2;

/** Everything the Overview's charts read, for the selected range. */
export interface ActivityData {
  points: () => SeriesPoint[];
  /** Held activity in scope; the heatmap and rhythm keep the rows inside `span`. */
  rows: () => ActivityBucket[];
  /** The page's time frame. */
  span: () => Span;
  now: () => number;
  models: () => ModelRow[];
  accounts: () => AccountRow[];
  clients: () => ClientRow[];
  /** Display name for an account, masked when "Show emails" is off. */
  account: (authIndex: string | null) => string;
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
  body: (spec: () => ActivityPanelSpec, data: ActivityData) => JSX.Element;
}

export const PANELS: Record<ActivityPanelKind, PanelDef> = {
  trend: {
    title: (spec) => metricLabel(spec.metric),
    note: (data) => data.bucketNote(),
    hasMetric: true,
    minSize: { width: 360, height: 170 },
    body: (spec, data) => (
      <TrendChart kind="bar" ariaLabel={metricLabel(spec().metric)}
        points={data.points().map((p) => ({ start: p.start, value: metricValue(p.summary, spec().metric) }))}
        yLabel={axisMetric(spec().metric)} xLabel={data.xLabel} tooltip={data.tip} />
    ),
  },
  cache: {
    title: () => 'Cache hit',
    note: () => 'Share of prompt tokens read from cache',
    hasMetric: false,
    minSize: { width: 320, height: 150 },
    body: (_spec, data) => (
      <TrendChart kind="line" ariaLabel="Cache hit" yMax={1} yTicks={CACHE_Y_TICKS}
        points={data.points().map((p) => ({ start: p.start, value: p.summary.cacheHitRate }))}
        yLabel={(v) => pct(v * 100)} xLabel={data.xLabel} tooltip={data.tip} />
    ),
  },
  heatmap: {
    title: () => 'Heatmap',
    hasMetric: true,
    // 34px labels + 24 × (10px cell + 3px gap) + 32px padding; 60px header + 18px hours + 7 × 13px rows + 26px legend.
    minSize: { width: 380, height: 200 },
    body: (spec, data) => (
      <ActivityHeatmap rows={data.rows()} span={data.span()} metric={spec().metric} format={(s) => formatMetric(spec().metric)(s)} tooltip={countRows} />
    ),
  },
  rhythm: {
    title: () => 'Rhythm',
    note: () => 'Each hour of the day, summed',
    hasMetric: true,
    minSize: { width: 380, height: 220 },
    body: (spec, data) => (
      <ActivityRhythm zipCode={settings().activity.zipCode} rows={data.rows()} span={data.span()} now={data.now()} metric={spec().metric}
        format={(s) => formatMetric(spec().metric)(s)} tooltip={countRows} />
    ),
  },
  models: {
    title: () => 'Models',
    hasMetric: true,
    minSize: { width: 420, height: 170 },
    body: (spec, data) => (
      <BreakdownTable heading="Model" metric={spec().metric} total={data.total()}
        rows={data.models().map((m) => ({ key: `${m.provider}|${m.model}`, provider: m.provider, name: m.model, summary: m.summary }))} />
    ),
  },
  accounts: {
    title: () => 'Accounts',
    hasMetric: true,
    minSize: { width: 420, height: 170 },
    body: (spec, data) => (
      <BreakdownTable heading="Account" metric={spec().metric} total={data.total()}
        rows={data.accounts().map((a) => ({ key: accountKey(a.authIndex), provider: a.provider, name: data.account(a.authIndex), summary: a.summary }))} />
    ),
  },
  clients: {
    title: () => 'Clients',
    hasMetric: true,
    minSize: { width: 420, height: 170 },
    body: (spec, data) => (
      <BreakdownTable heading="Client" metric={spec().metric} total={data.total()}
        rows={data.clients().map((c) => ({ key: clientKey(c.client), name: clientLabel(c.client), summary: c.summary }))} />
    ),
  },
};

/** The "Add chart" menu: each trend metric is its own choice. */
export const ADD_CHOICES: { label: string; spec: ActivityPanelSpec }[] = [
  { label: 'API cost', spec: { kind: 'trend', metric: 'cost' } },
  { label: 'Tokens', spec: { kind: 'trend', metric: 'tokens' } },
  { label: 'Requests', spec: { kind: 'trend', metric: 'requests' } },
  { label: 'Cache hit', spec: { kind: 'cache', metric: 'cost' } },
  { label: 'Heatmap', spec: { kind: 'heatmap', metric: 'cost' } },
  { label: 'Rhythm', spec: { kind: 'rhythm', metric: 'cost' } },
  { label: 'Models', spec: { kind: 'models', metric: 'cost' } },
  { label: 'Accounts', spec: { kind: 'accounts', metric: 'cost' } },
  { label: 'Clients', spec: { kind: 'clients', metric: 'cost' } },
];
