import { For, Show, type JSX } from 'solid-js';
import { KvTooltip, KvTooltipPanel, type KvTooltipAnchor } from '@cujuju/solidjs-kv-tooltip';

export interface TipRow {
  label: string;
  value: string;
  /** Series swatch beside the label. */
  color?: string;
}

/** Widest readout (title plus seven rows); the panel clamps inside the window either way. */
const TIP_MAX_WIDTH = 280;

/**
 * Chart hover readout: a title, then label-left / value-right rows. The toolkit panel portals it
 * and clamps it inside the window, flipping sides at an edge.
 */
export function ChartTip(props: { title: string; rows: TipRow[]; x?: number; y?: number; anchor?: KvTooltipAnchor }) {
  return (
    <KvTooltipPanel
      entries={{}}
      x={props.x ?? 0}
      y={props.y ?? 0}
      anchor={props.anchor}
      placement={props.anchor ? 'below-start' : 'cursor'}
      maxWidth={TIP_MAX_WIDTH}
      panelClass="chart-tip"
      extraContent={<TipBody title={props.title} rows={props.rows} />}
    />
  );
}

/** The same readout on hover or focus of `children`. Use `contents` around a focusable control to preserve its layout. */
export function HoverTip(props: { title: string; rows: TipRow[]; class?: string; focusable?: boolean; layout?: 'control' | 'block' | 'contents'; children: JSX.Element }) {
  return (
    <KvTooltip
      entries={{}}
      maxWidth={TIP_MAX_WIDTH}
      panelClass="chart-tip"
      class={props.class}
      wrapperLayout={props.layout ?? 'control'}
      focusable={props.focusable}
      description={[props.title, ...props.rows.map((r) => `${r.label}: ${r.value}`)].join('. ')}
      extraContent={<TipBody title={props.title} rows={props.rows} />}
    >
      {props.children}
    </KvTooltip>
  );
}

function TipBody(props: { title: string; rows: TipRow[] }) {
  return (
    <>
      <div class="tip-title">{props.title}</div>
      <For each={props.rows}>
        {(r) => (
          <div class="tip-row">
            <span>
              <Show when={r.color}><i class="tip-swatch" style={{ background: r.color }} /></Show>
              {r.label}
            </span>
            <strong>{r.value}</strong>
          </div>
        )}
      </For>
    </>
  );
}
