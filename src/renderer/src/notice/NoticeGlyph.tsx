import { ArrowLeftRight, Ban, Download, Power, RotateCcw, TriangleAlert } from 'lucide-solid';
import type { Component } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { NOTICE_TONE, type NoticeKind } from '@shared/notice';

const ICON: Record<NoticeKind, Component<{ size?: number; 'aria-hidden'?: boolean }>> = {
  limitHit: Ban,
  limitReset: RotateCcw,
  accountSwitched: ArrowLeftRight,
  proxyStopped: Power,
  updateFound: Download,
  clientDrift: TriangleAlert,
};

/** Icons sit at about half the glyph tile. */
const ICON_PX = 13;

/** The tinted tile that tells notice kinds apart by icon, not colour alone. */
export function NoticeGlyph(props: { kind: NoticeKind }) {
  return (
    <span class="notice-glyph" data-tone={NOTICE_TONE[props.kind]}>
      <Dynamic component={ICON[props.kind]} size={ICON_PX} aria-hidden={true} />
    </span>
  );
}
