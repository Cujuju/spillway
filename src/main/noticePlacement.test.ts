import { describe, expect, it } from 'vitest';
import { overlayBounds, type DisplayArea } from './noticePlacement';

const SCREEN = { x: 0, y: 0, width: 1920, height: 1080 };
const TASKBAR = 48;
const size = { width: 300, height: 100 };
const display = (workArea: DisplayArea['workArea']): DisplayArea => ({ bounds: SCREEN, workArea });

describe('overlayBounds', () => {
  it('puts tray styles above a bottom taskbar, at the right', () => {
    expect(overlayBounds('tray', size, display({ x: 0, y: 0, width: 1920, height: 1080 - TASKBAR }))).toEqual({ x: 1620, y: 932, width: 300, height: 100 });
  });

  it('puts tray styles below a top bar (macOS menu bar)', () => {
    expect(overlayBounds('console', size, display({ x: 0, y: 25, width: 1920, height: 1055 }))).toEqual({ x: 1620, y: 25, width: 300, height: 100 });
  });

  it('puts tray styles beside a left taskbar, at the bottom', () => {
    expect(overlayBounds('tray', size, display({ x: TASKBAR, y: 0, width: 1920 - TASKBAR, height: 1080 }))).toEqual({ x: TASKBAR, y: 980, width: 300, height: 100 });
  });

  it('hangs the drip from the top of the work area, centred', () => {
    expect(overlayBounds('drip', size, display({ x: 0, y: 25, width: 1920, height: 1055 }))).toEqual({ x: 810, y: 25, width: 300, height: 100 });
  });

  it('follows a secondary display and never outgrows the work area', () => {
    const area = { x: 1920, y: 0, width: 200, height: 80 };
    expect(overlayBounds('tray', size, { bounds: area, workArea: area })).toEqual({ x: 1920, y: 0, width: 200, height: 80 });
  });
});
