import type { TrayIconLook, TrayIconShape, TrayIconSpec } from '@shared/settings';
import { providerColor } from './providers';

/** Windows tray icons are 16 px at 100% scaling; the 2x image covers 200%. */
export const TRAY_PX_1X = 16;
export const TRAY_PX_2X = 32;

export interface TrayIconPaint {
  shape: TrayIconLook['shape'];
  fill: TrayIconLook['fill'];
  /** Resolved #rrggbb: the icon's own colour or its provider's. */
  color: string;
  /** Taskbar theme: digit colour for outlines, which have nothing behind the digits. */
  darkTaskbar: boolean;
}

const DIGITS_ON_DARK = '#ffffff';
const DIGITS_ON_LIGHT = '#1f2937';
/** WCAG relative luminance where white and near-black text contrast equally against a fill. */
const WHITE_TEXT_MAX_LUMINANCE = 0.179;
/** 1 px outline at 16 px, 2 px at 32 px. */
const OUTLINE_PER_EDGE = 1 / 16;
/**
 * fontRatio: digit height as a share of the edge. fitRatio: share of the inner width the digits may span;
 * wider text ("100") shrinks to fit. A circle leaves less width at the digits' top and bottom.
 */
const SHAPE_TEXT: Record<TrayIconShape, { fontRatio: number; fitRatio: number }> = {
  square: { fontRatio: 0.62, fitRatio: 0.84 },
  circle: { fontRatio: 0.56, fitRatio: 0.74 },
  none: { fontRatio: 0.8, fitRatio: 1 },
};
/** Regular weight in the OS UI font, like the taskbar clock beside it. */
const TRAY_FONT_WEIGHT = 400;
const TRAY_FONT = "'Segoe UI Variable Text', 'Segoe UI', -apple-system, system-ui, sans-serif";

/** WCAG relative luminance of a #rrggbb colour. */
export function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function shapePath(ctx: CanvasRenderingContext2D, shape: Exclude<TrayIconShape, 'none'>, inset: number, size: number): void {
  const edge = size - 2 * inset;
  ctx.beginPath();
  if (shape === 'circle') ctx.arc(size / 2, size / 2, edge / 2, 0, 2 * Math.PI);
  else ctx.rect(inset, inset, edge, edge);
}

const OPAQUE_HEX = /^#[0-9a-f]{6}$/i;

function digitColor(p: TrayIconPaint): string {
  if (p.shape === 'none') return p.color;
  // Translucent fills (theme colours can be rgba) show the taskbar through, so they follow it like an outline.
  if (p.fill === 'filled' && OPAQUE_HEX.test(p.color)) return luminance(p.color) <= WHITE_TEXT_MAX_LUMINANCE ? DIGITS_ON_DARK : DIGITS_ON_LIGHT;
  return p.darkTaskbar ? DIGITS_ON_DARK : DIGITS_ON_LIGHT;
}

/** Any CSS colour as the canvas normalizes it: #rrggbb when opaque, rgba() otherwise. */
function canvasColor(css: string): string {
  const ctx = document.createElement('canvas').getContext('2d')!;
  ctx.fillStyle = css;
  return String(ctx.fillStyle);
}

/** The icon's look with its colour resolved (own colour, else the provider's). */
export const paintFor = (spec: TrayIconSpec, darkTaskbar: boolean): TrayIconPaint => ({
  shape: spec.look.shape,
  fill: spec.look.fill,
  color: spec.look.color ?? canvasColor(providerColor(spec.provider)),
  darkTaskbar,
});

/** Draws one tray icon: a number in an optional outlined or filled shape, returned as a PNG data URL. */
export function drawTrayIcon(size: number, text: string, p: TrayIconPaint): string {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const line = p.shape !== 'none' && p.fill === 'outline' ? Math.max(1, Math.round(size * OUTLINE_PER_EDGE)) : 0;
  if (p.shape !== 'none') {
    // Inset an outline by half its width so the stroke's outer edge is the icon edge and a 1 px line stays crisp.
    shapePath(ctx, p.shape, line / 2, size);
    if (p.fill === 'filled') {
      ctx.fillStyle = p.color;
      ctx.fill();
    } else {
      ctx.lineWidth = line;
      ctx.strokeStyle = p.color;
      ctx.stroke();
    }
  }

  const { fontRatio, fitRatio } = SHAPE_TEXT[p.shape];
  const font = (px: number) => `${TRAY_FONT_WEIGHT} ${px}px ${TRAY_FONT}`;
  let px = size * fontRatio;
  ctx.font = font(px);
  const room = (size - 2 * line) * fitRatio;
  const width = ctx.measureText(text).width;
  if (width > room) {
    px *= room / width;
    ctx.font = font(px);
  }
  // Centre on the glyphs' own ink box; the 'middle' baseline sits high for digits.
  const m = ctx.measureText(text);
  ctx.fillStyle = digitColor(p);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, size / 2, size / 2 + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2);
  return canvas.toDataURL('image/png');
}
