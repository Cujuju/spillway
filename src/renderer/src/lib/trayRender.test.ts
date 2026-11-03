import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_TRAY_LOOK, type TrayIconSpec } from '@shared/settings';
import { THEMES } from '@shared/themes';
import { paintFor } from './trayRender';

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
