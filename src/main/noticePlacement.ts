import type { NoticeStyle } from '@shared/notice';

export interface Rect { x: number; y: number; width: number; height: number }
export interface DisplayArea { bounds: Rect; workArea: Rect }

/**
 * Overlay window bounds, flush with the work area (the renderer pads). Top drip: top centre.
 * Other styles: the corner nearest the tray, on the side the taskbar takes.
 */
export function overlayBounds(style: NoticeStyle, size: { width: number; height: number }, display: DisplayArea): Rect {
  const { bounds: b, workArea: a } = display;
  const width = Math.min(Math.round(size.width), a.width);
  const height = Math.min(Math.round(size.height), a.height);
  if (style === 'drip') return { x: a.x + Math.round((a.width - width) / 2), y: a.y, width, height };
  const barOnLeft = a.x > b.x;
  const barOnTop = a.y > b.y;
  return {
    x: barOnLeft ? a.x : a.x + a.width - width,
    y: barOnTop ? a.y : a.y + a.height - height,
    width,
    height,
  };
}
