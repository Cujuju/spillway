import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ powerMonitor: { on: vi.fn() } }));
vi.mock('./settingsStore', () => ({}));
vi.mock('./updater', () => ({}));

import { nextInstallAt } from './updateInstaller';

describe('nextInstallAt', () => {
  const minute = 3 * 60;

  it('uses today when the minute is ahead', () => {
    expect(nextInstallAt(minute, new Date(2026, 10, 6, 2, 59))).toBe(new Date(2026, 10, 6, 3).getTime());
  });

  it('uses tomorrow when the minute has passed', () => {
    expect(nextInstallAt(minute, new Date(2026, 10, 6, 3, 1))).toBe(new Date(2026, 10, 7, 3).getTime());
  });

  it('uses tomorrow at exactly the minute', () => {
    expect(nextInstallAt(minute, new Date(2026, 10, 6, 3))).toBe(new Date(2026, 10, 7, 3).getTime());
  });

  it('rolls over the day and year at midnight', () => {
    expect(nextInstallAt(0, new Date(2026, 11, 31, 23, 59))).toBe(new Date(2027, 0, 1).getTime());
  });
});
