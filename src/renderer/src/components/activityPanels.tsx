import type { TileSize } from '@cujuju/solidjs-tiling-window-manager';
import { createMemo, Show, type JSX } from 'solid-js';
import type { CompareReport } from '@shared/activityCompare';
import type { ActivityPanelKind, ActivityPanelSpec } from '@shared/activityBoard';
import { accountKey, clientKey } from '@shared/activityScope';
import { clientLabel } from '../lib/accountScope';
import type { ActivityBucket } from '@shared/types';
import { metricValue, type AccountRow, type ClientRow, type ModelEffortRow, type ModelRow, type SeriesPoint, type Summary } from '../lib/activityStats';
import { settings } from '../store';
import { pct } from '../lib/format';
import type { Span } from '../lib/activityRange';
import { ActivityHeatmap } from './ActivityHeatmap';
import { ActivityRhythm } from './ActivityRhythm';
import { EffortsInfo, EffortsTable } from './ActivityEfforts';
import { axisMetric, countRows, formatMetric, metricLabel } from './activityFormat';
import type { TipRow } from './ChartTip';
import { BreakdownTable } from './BreakdownTable';
import { ComboCard } from './ComboCard';
import { CompareTable } from './CompareTable';
import { comboName } from '../lib/comboSelection';
import { TREND_MIN_HEIGHT_PX, TrendChart } from './TrendChart';

/** The hit rate sits near 100% most of the time; 0/50/100% lines are enough. */
const CACHE_Y_TICKS = 2;
/** A tile's height around its body: 2 × (12px padding + 1px border) + 20px header + 6px header gap. */
const TILE_CHROME_PX = 52;
/** A trend tile is as short as its chart allows. */
const TREND_TILE_MIN_HEIGHT_PX = TILE_CHROME_PX + TREND_MIN_HEIGHT_PX;
/** A table tile: its header and two rows; wider tables scroll sideways. */
const TABLE_TILE_MIN: TileSize = { width: 420, height: 170 };
/** A combination card: its title, the median line and the five-line ledger. */
const COMBO_TILE_MIN: TileSize = { width: 240, height: 230 };

/** Everything the Overview's charts read, for the selected range. */
export interface ActivityData {
  points: () => SeriesPoint[];
  /** Held activity in scope; the heatmap and rhythm keep the rows inside `span`. */
  rows: () => ActivityBucket[];
  /** The page's time frame. */
  span: () => Span;
  now: () => number;
  models: () => ModelRow[];
  efforts: () => ModelEffortRow[];
  accounts: () => AccountRow[];
  clients: () => ClientRow[];
  /** Display name for an account, masked when "Show emails" is off. */
  account: (authIndex: string | null) => string;
  total: () => Summary;
  /** "Hourly", "Daily" … for the range. */
  bucketNote: () => string;
  xLabel: (t: number) => string;
  tip: (i: number) => { title: string; rows: TipRow[] };
  /** Combination cards and Compare; undefined while loading, null for a query main rejected. */
  compare: () => CompareReport | null | undefined;
  retentionDays: () => number;
}

/** The board's combination cards: what each shows, in board order, and Compare's baseline. */
export interface ComboSelection {
  of: (tileId: string) => string | null;
  shown: () => string[];
  baseline: () => string | null;
  setBaseline: (key: string) => void;
}

/** What a tile knows about its place on the board. */
export interface TileContext { id: string; selection: ComboSelection }

/** Swatch class for a shown combination: one series colour per position. */
const seriesClass = (selection: ComboSelection, key: string) => `swatch series-${selection.shown().indexOf(key) + 1}`;

interface PanelDef {
  title: (spec: ActivityPanelSpec) => string;
  /** Replaces the title text when the tile's title depends on its place on the board. */
  heading?: (tile: TileContext) => JSX.Element;
  /** Small muted title, for a tile whose note says more. */
  quiet?: boolean;
  /** The body reaches the tile's edges, like a full-width table. */
  bleed?: boolean;
  removeLabel?: string;
  note?: (data: ActivityData, tile: TileContext) => string;
  /** An info icon after the title, for a tile that needs more than a note. */
  info?: () => JSX.Element;
  /** The title is a menu switching the tile's metric; each option is the title for that metric. Tables show every metric as a column, so they have none. */
  switchesMetric: boolean;
  /** Smallest tile that still reads: axis labels plus a few bars, or a header and two table rows. */
  minSize: TileSize;
  /** Builds the tile body once per tile; it reads `spec` inside its own JSX and memos. */
  createBody: (spec: () => ActivityPanelSpec, data: ActivityData, tile: TileContext) => JSX.Element;
}

export const PANELS: Record<ActivityPanelKind, PanelDef> = {
  trend: {
    title: (spec) => metricLabel(spec.metric),
    note: (data) => data.bucketNote(),
    switchesMetric: true,
    minSize: { width: 360, height: TREND_TILE_MIN_HEIGHT_PX },
    createBody: (spec, data) => {
      // Built once per data or metric change, not on every read while the chart resizes.
      const points = createMemo(() => data.points().map((p) => ({ start: p.start, value: metricValue(p.summary, spec().metric) })));
      return (
        <TrendChart kind="bar" ariaLabel={metricLabel(spec().metric)} points={points()}
          yLabel={axisMetric(spec().metric)} xLabel={data.xLabel} tooltip={data.tip} />
      );
    },
  },
  cache: {
    title: () => 'Cache hit',
    note: () => 'Share of prompt tokens read from cache',
    switchesMetric: false,
    minSize: { width: 320, height: TREND_TILE_MIN_HEIGHT_PX },
    createBody: (_spec, data) => {
      const points = createMemo(() => data.points().map((p) => ({ start: p.start, value: p.summary.cacheHitRate })));
      return (
        <TrendChart kind="line" ariaLabel="Cache hit" yMax={1} yTicks={CACHE_Y_TICKS} points={points()}
          yLabel={(v) => pct(v * 100)} xLabel={data.xLabel} tooltip={data.tip} />
      );
    },
  },
  heatmap: {
    title: (spec) => `Heatmap · ${metricLabel(spec.metric)}`,
    switchesMetric: true,
    // 34px labels + 24 × (10px cell + 3px gap) + 32px padding; 60px header + 18px hours + 7 × 13px rows + 26px legend.
    minSize: { width: 380, height: 200 },
    createBody: (spec, data) => (
      <ActivityHeatmap rows={data.rows()} span={data.span()} metric={spec().metric} format={(s) => formatMetric(spec().metric)(s)} tooltip={countRows} />
    ),
  },
  rhythm: {
    title: (spec) => `Rhythm · ${metricLabel(spec.metric)}`,
    note: () => 'Each hour of the day, summed',
    switchesMetric: true,
    minSize: { width: 380, height: 220 },
    createBody: (spec, data) => (
      <ActivityRhythm zipCode={settings().activity.zipCode} rows={data.rows()} span={data.span()} now={data.now()} metric={spec().metric}
        format={(s) => formatMetric(spec().metric)(s)} tooltip={countRows} />
    ),
  },
  models: {
    title: () => 'Models',
    switchesMetric: false,
    minSize: TABLE_TILE_MIN,
    createBody: (spec, data) => (
      <BreakdownTable heading="Model" metric={spec().metric} total={data.total()}
        rows={data.models().map((m) => ({ key: `${m.provider}|${m.model}`, provider: m.provider, name: m.model, summary: m.summary }))} />
    ),
  },
  accounts: {
    title: () => 'Accounts',
    switchesMetric: false,
    minSize: TABLE_TILE_MIN,
    createBody: (spec, data) => (
      <BreakdownTable heading="Account" metric={spec().metric} total={data.total()}
        rows={data.accounts().map((a) => ({ key: accountKey(a.authIndex), provider: a.provider, name: data.account(a.authIndex), summary: a.summary }))} />
    ),
  },
  clients: {
    title: () => 'Clients',
    switchesMetric: false,
    minSize: TABLE_TILE_MIN,
    createBody: (spec, data) => (
      <BreakdownTable heading="Client" metric={spec().metric} total={data.total()}
        rows={data.clients().map((c) => ({ key: clientKey(c.client), name: clientLabel(c.client), summary: c.summary }))} />
    ),
  },
  efforts: {
    title: () => 'Model and effort',
    info: EffortsInfo,
    switchesMetric: false,
    minSize: TABLE_TILE_MIN,
    createBody: (_spec, data) => <EffortsTable rows={data.efforts()} />,
  },
  combo: {
    title: () => 'Combination',
    heading: (tile) => (
      <Show when={tile.selection.of(tile.id)} fallback="Combination">
        {(key) => <span class="combo-title"><span class={seriesClass(tile.selection, key())} />{comboName(key())}</span>}
      </Show>
    ),
    note: (_data, tile) => (tile.selection.of(tile.id) !== null && tile.selection.of(tile.id) === tile.selection.baseline() ? 'baseline' : ''),
    removeLabel: 'Remove combination',
    switchesMetric: false,
    minSize: COMBO_TILE_MIN,
    createBody: (_spec, data, tile) => (
      <Show when={data.compare() && tile.selection.of(tile.id)} fallback={<div class="muted">{data.compare() === undefined ? 'Loading…' : 'No more combinations in this range.'}</div>}>
        {(key) => <ComboCard report={data.compare()!} combo={key()} />}
      </Show>
    ),
  },
  compare: {
    title: () => 'Compare',
    quiet: true,
    bleed: true,
    note: () => 'Multiples are against the baseline column. Shares show the difference in points.',
    switchesMetric: false,
    minSize: TABLE_TILE_MIN,
    createBody: (_spec, data, tile) => (
      <Show when={data.compare() && tile.selection.shown().length > 0} fallback={<div class="muted cmp-empty">{data.compare() === undefined ? 'Loading…' : 'Add a combination card to compare.'}</div>}>
        <CompareTable report={data.compare()!} shown={tile.selection.shown()} baseline={tile.selection.baseline()}
          retentionDays={data.retentionDays()} onBaseline={tile.selection.setBaseline} />
      </Show>
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
  { label: 'Model and effort', spec: { kind: 'efforts', metric: 'cost' } },
  { label: 'Compare', spec: { kind: 'compare', metric: 'cost' } },
];
