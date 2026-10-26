import type { TrayLevel } from '@shared/trayValues';

/** Windows tray icons are 16 px at 100% scaling; the 2x image covers 200%. */
export const TRAY_PX_1X = 16;
export const TRAY_PX_2X = 32;

export interface TrayIconLook {
  level: TrayLevel;
  /** Outline colour while the limit is fine. */
  providerColor: string;
  /** Taskbar theme: picks digit colour, since the icon has no fill behind the digits. */
  darkTaskbar: boolean;
}

/** Low limits override the provider colour so they stand out. */
const ALERT_OUTLINE: Record<Exclude<TrayLevel, 'ok'>, string> = {
  warn: '#f59e0b',
  critical: '#ef4444',
  none: '#64748b',
};
const DIGITS_ON_DARK = '#ffffff';
const DIGITS_ON_LIGHT = '#1f2937';
/** 1 px outline at 16 px, 2 px at 32 px. */
const OUTLINE_PER_EDGE = 1 / 16;
/** Corner radius as a share of the icon edge. */
const CORNER_RATIO = 0.22;
/** Digit height as a share of the edge; wider text ("100") shrinks to fit. */
const FONT_RATIO = 0.62;
/** Share of the space inside the outline the digits may span, leaving a gap to the line. */
const TEXT_FIT_RATIO = 0.84;
/** Regular weight in the OS UI font, like the taskbar clock beside it. */
const TRAY_FONT_WEIGHT = 400;
const TRAY_FONT = "'Segoe UI Variable Text', 'Segoe UI', -apple-system, system-ui, sans-serif";

/** Draws a rounded-rectangle outline around a number, returned as a PNG data URL. */
export function drawTrayIcon(size: number, text: string, look: TrayIconLook): string {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const line = Math.max(1, Math.round(size * OUTLINE_PER_EDGE));
  // Centre the stroke on the half pixel so a 1 px line stays crisp.
  ctx.beginPath();
  ctx.roundRect(line / 2, line / 2, size - line, size - line, size * CORNER_RATIO);
  ctx.lineWidth = line;
  ctx.strokeStyle = look.level === 'ok' ? look.providerColor : ALERT_OUTLINE[look.level];
  ctx.stroke();

  const font = (px: number) => `${TRAY_FONT_WEIGHT} ${px}px ${TRAY_FONT}`;
  let px = size * FONT_RATIO;
  ctx.font = font(px);
  const room = (size - 2 * line) * TEXT_FIT_RATIO;
  const width = ctx.measureText(text).width;
  if (width > room) {
    px *= room / width;
    ctx.font = font(px);
  }
  // Centre on the glyphs' own ink box; 'middle' baseline sits high for digits.
  const m = ctx.measureText(text);
  ctx.fillStyle = look.darkTaskbar ? DIGITS_ON_DARK : DIGITS_ON_LIGHT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, size / 2, size / 2 + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2);
  return canvas.toDataURL('image/png');
}
