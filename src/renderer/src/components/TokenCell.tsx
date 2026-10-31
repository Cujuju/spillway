import { HoverTip } from './ChartTip';
import { Show } from 'solid-js';
import { reportsCacheWrites } from '@shared/modelPrices';
import { compactNumber } from '../lib/format';

/**
 * A compact token count, exact on hover; zero is muted. With `provider`, the cell is a cache-write
 * count and shows "—" for providers that report none.
 */
export function TokenCell(props: { v: number; provider?: string }) {
  return (
    <Show when={props.provider === undefined || reportsCacheWrites(props.provider)} fallback={<td class="num zero" title="Not reported by this provider">—</td>}>
      <td class="tabular num" classList={{ zero: props.v === 0 }}><HoverTip title="Tokens" rows={[{ label: 'Exact', value: props.v.toLocaleString() }]}>{compactNumber(props.v)}</HoverTip></td>
    </Show>
  );
}
