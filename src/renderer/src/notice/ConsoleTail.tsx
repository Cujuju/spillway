import { For, Show } from 'solid-js';
import { isSticky, NOTICE_TONE, type NoticeKind } from '@shared/notice';
import { clockText } from '@shared/resetTime';
import type { NoticeListProps } from './TrayDrip';

/** A coloured tag stands in for the icon. */
const TAG: Record<NoticeKind, string> = {
  limitHit: 'LIMIT',
  limitReset: 'RESET',
  accountSwitched: 'SWITCH',
  proxyStopped: 'PROXY',
  updateFound: 'UPDATE',
  clientDrift: 'DRIFT',
};

/** Console: notices as log lines, newest at the bottom; errors stay highlighted until handled. */
export function ConsoleTail(props: NoticeListProps & { lines: number }) {
  const shown = () => props.items.slice(-props.lines);
  return (
    <Show when={props.items.length > 0}>
      <div class="console" role="log">
        <div class="console-head">
          <span>spillway</span>
          <button type="button" onClick={() => props.onClear()}>clear</button>
        </div>
        <For each={shown()}>
          {(n) => (
            <div class="console-row" data-tone={NOTICE_TONE[n.kind]} classList={{ sticky: isSticky(n) }}>
              <button type="button" class="console-line" onClick={() => props.onOpen(n)}>
                <span class="notice-time">{clockText(n.at, Date.now())}</span>
                <span class="console-tag">{TAG[n.kind]}</span>
                <span class="console-msg">
                  {n.title}
                  <Show when={n.body}><span class="console-body"> · {n.body}</span></Show>
                </span>
              </button>
              <button type="button" class="notice-dismiss" aria-label="Dismiss" onClick={() => props.onDismiss(n.id)}>×</button>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
