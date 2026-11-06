import { X } from 'lucide-solid';
import { For, Show } from 'solid-js';
import { NOTICE_TONE, type Notice } from '@shared/notice';
import { clockText } from '@shared/resetTime';
import { NoticeGlyph } from './NoticeGlyph';

/** Cards on screen at once; older notices fold into the counter above them. */
const TRAY_VISIBLE = 3;
const DISMISS_ICON_PX = 12;

export interface NoticeListProps {
  items: Notice[];
  onOpen: (n: Notice) => void;
  onDismiss: (id: number) => void;
  onClear: () => void;
}

/** Tray drip: one-line rounded cards stacked by the tray, newest nearest it. Hover expands a card. */
export function TrayDrip(props: NoticeListProps) {
  const shown = () => props.items.slice(-TRAY_VISIBLE);
  const hidden = () => props.items.length - shown().length;
  return (
    <Show when={props.items.length > 0}>
      <div class="tray">
        <Show when={hidden() > 0}>
          <div class="tray-more">
            <span>{hidden()} earlier</span>
            <button type="button" onClick={() => props.onClear()}>Clear all</button>
          </div>
        </Show>
        <For each={shown()}>
          {(n, i) => (
            <div class="tray-card" data-tone={NOTICE_TONE[n.kind]} style={{ '--age': String(shown().length - 1 - i()) }}>
              <button type="button" class="tray-main" onClick={() => props.onOpen(n)}>
                <NoticeGlyph kind={n.kind} />
                <span class="tray-text">
                  <span class="tray-title">{n.title}</span>
                  <Show when={n.body}><span class="tray-body">{n.body}</span></Show>
                </span>
                <span class="notice-time">{clockText(n.at, Date.now())}</span>
              </button>
              <button type="button" class="notice-dismiss" aria-label="Dismiss" onClick={() => props.onDismiss(n.id)}>
                <X size={DISMISS_ICON_PX} aria-hidden={true} />
              </button>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
