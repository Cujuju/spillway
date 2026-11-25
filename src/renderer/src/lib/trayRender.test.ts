import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_TRAY_LOOK, type TrayIconSpec } from '@shared/settings';
import { THEMES } from '@shared/themes';
import { drawTrayIcon, paintFor, TRAY_PX_1X, TRAY_PX_2X, type TrayIconPaint } from './trayRender';

vi.mock('./providers', () => ({ providerColor: () => '#abcdef' }));
beforeEach(() => vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ fillStyle: '' }) }) }));
afterEach(() => vi.unstubAllGlobals());
const thresholds = { warnAtPercentUsed: 75, criticalAtPercentUsed: 90 };
const spec: TrayIconSpec = { id: 'test', provider: 'claude', windowKey: 'five_hour', scope: 'active', look: DEFAULT_TRAY_LOOK };

it.each([null, '#123456'])('uses theme warning colours for both default and custom icons (%s)', (color) => {
  const icon = { ...spec, look: { shape: 'circle', fill: 'filled', color } } as const;
  const palette = THEMES.find((t) => t.id === 'nord')!.palette;
  expect(paintFor(icon, true, 75, thresholds, palette)).toEqual({ shape: 'circle', fill: 'filled', color: palette.amber, darkTaskbar: true });
  expect(paintFor(icon, false, 95, thresholds, palette)).toEqual({ shape: 'circle', fill: 'filled', color: palette.red, darkTaskbar: false });
  for (const reading of [20, null]) expect(paintFor(icon, true, reading, thresholds, palette).color).toBe(color ?? '#abcdef');
});

it('responds to changed thresholds and themes without changing icon geometry', () => {
  const palette = THEMES.find((t) => t.id === 'dracula')!.palette;
  expect(paintFor(spec, true, 80, thresholds, palette).color).toBe(palette.amber);
  expect(paintFor(spec, true, 80, { warnAtPercentUsed: 85, criticalAtPercentUsed: 95 }, palette).color).toBe('#abcdef');
  const next = THEMES.find((t) => t.id === 'nord')!.palette;
  expect(paintFor(spec, true, 95, thresholds, next).color).toBe(next.red);
});

it('caches PNGs by all draw inputs and reuses the canvas for each size', () => {
  const ctx = () => ({
    clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), rect: vi.fn(),
    fill: vi.fn(), stroke: vi.fn(), fillText: vi.fn(),
    measureText: () => ({ width: 8, actualBoundingBoxAscent: 6, actualBoundingBoxDescent: 0 }),
  });
  const contexts = [ctx(), ctx()];
  const canvases = contexts.map((context) => ({ getContext: () => context, toDataURL: vi.fn(() => 'data:image/png;base64,mock') }));
  const createElement = vi.fn().mockReturnValueOnce(canvases[0]).mockReturnValueOnce(canvases[1]);
  vi.stubGlobal('document', { createElement });

  const paint: TrayIconPaint = { shape: 'circle', fill: 'filled', color: '#abcdef', darkTaskbar: true };
  const png = drawTrayIcon(TRAY_PX_1X, '50', paint);
  expect(drawTrayIcon(TRAY_PX_1X, '50', { ...paint })).toBe(png);
  expect(contexts[0]!.fillText).toHaveBeenCalledOnce();
  expect(canvases[0]!.toDataURL).toHaveBeenCalledOnce();

  drawTrayIcon(TRAY_PX_2X, '50', paint);
  drawTrayIcon(TRAY_PX_1X, '51', paint);
  drawTrayIcon(TRAY_PX_1X, '50', { ...paint, shape: 'square' });
  drawTrayIcon(TRAY_PX_1X, '50', { ...paint, fill: 'outline' });
  drawTrayIcon(TRAY_PX_1X, '50', { ...paint, color: '#fedcba' });
  drawTrayIcon(TRAY_PX_1X, '50', { ...paint, darkTaskbar: false });

  expect(createElement).toHaveBeenCalledTimes(2);
  expect(contexts[0]!.fillText).toHaveBeenCalledTimes(6);
  expect(contexts[0]!.clearRect.mock.calls).toEqual(Array.from({ length: 6 }, () => [0, 0, TRAY_PX_1X, TRAY_PX_1X]));
  expect(canvases[0]!.toDataURL).toHaveBeenCalledTimes(6);
  expect(contexts[1]!.fillText).toHaveBeenCalledOnce();
  expect(contexts[1]!.clearRect).toHaveBeenCalledWith(0, 0, TRAY_PX_2X, TRAY_PX_2X);
  expect(canvases[1]!.toDataURL).toHaveBeenCalledOnce();
});
