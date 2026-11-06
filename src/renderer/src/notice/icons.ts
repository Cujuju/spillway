import { ArrowLeftRight, Ban, Download, Power, RotateCcw, TriangleAlert } from 'lucide-solid';
import type { NoticeIcon } from '@cujuju/electron-notices/renderer';
import type { SpillwayNoticeKind } from '@shared/notice';

/** Spillway's icon per notice kind; spillwayNotice() sets each notice's icon key to its kind. */
export const NOTICE_ICONS: Record<SpillwayNoticeKind, NoticeIcon> = {
  limitHit: Ban,
  limitReset: RotateCcw,
  accountSwitched: ArrowLeftRight,
  proxyStopped: Power,
  updateFound: Download,
  clientDrift: TriangleAlert,
};
