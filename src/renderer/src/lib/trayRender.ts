import type { TrayLevel } from '@shared/trayValues';

/** Windows tray icons are 16 px at 100% scaling; the 2x image covers 200%. */
export const TRAY_PX_1X = 16;
export const TRAY_PX_2X = 32;

const LEVEL_FILL: Record<TrayLevel, string> = {
  ok: '#10b981',
  warn: '#f59e0b',
  critical: '#ef4444',
  none: '#475569',
};
/** Corner radius as a share of the icon edge. */
const CORNER_RATIO = 0.22;
/** Font heights as a share of the edge: two digits fill the tile, three need to shrink. */
const FONT_RATIO_2_DIGITS = 0.72;
const FONT_RATIO_3_DIGITS = 0.5;
/** A provider stripe along the bottom edge so same-valued icons stay tellable apart. */
const STRIPE_RATIO = 0.14;

function roundedRect(ctx: CanvasRenderingContext2D, size: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(size, 0, size, size, r);
  ctx.arcTo(size, size, 0, size, r);
  ctx.arcTo(0, size, 0, 0, r);
  ctx.arcTo(0, 0, size, 0, r);
  ctx.closePath();
}

/** Draws a filled tile with a number, returned as a PNG data URL. */
export function drawTrayIcon(size: number, text: string, level: TrayLevel, stripeColor: string | null): string {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  roundedRect(ctx, size, size * CORNER_RATIO);
  ctx.fillStyle = LEVEL_FILL[level];
  ctx.fill();
  if (stripeColor) {
    ctx.save();
    ctx.clip();
    ctx.fillStyle = stripeColor;
    ctx.fillRect(0, size * (1 - STRIPE_RATIO), size, size * STRIPE_RATIO);
    ctx.restore();
  }
  const ratio = text.length >= 3 ? FONT_RATIO_3_DIGITS : FONT_RATIO_2_DIGITS;
  ctx.font = `700 ${Math.round(size * ratio)}px "Segoe UI", Arial, sans-serif`;
  ctx.fillStyle = level === 'warn' ? '#0a0f1c' : '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Nudge up so the stripe never covers the glyph baseline.
  ctx.fillText(text, size / 2, size * (stripeColor ? 0.45 : 0.53));
  return canvas.toDataURL('image/png');
}
