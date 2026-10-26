import { For, Show } from 'solid-js';
import { KvTooltipPanel, type KvTooltipAnchor } from '@cujuju/solidjs-kv-tooltip';

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
      extraContent={
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
      }
    />
  );
}
