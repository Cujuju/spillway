import { afterAll, expect, it, vi } from 'vitest';
import { HOUR_CYCLE_ARG } from '@shared/timeFormat';

const electron = vi.hoisted(() => ({ ready: false }));
// Electron 45's own pre-ready behaviour (electron_api_app.cc): the system locale throws until ready.
vi.mock('electron', () => ({
  app: {
    isReady: () => electron.ready,
    getSystemLocale: () => {
      if (!electron.ready) throw new Error('app.getSystemLocale() can only be called after app is ready');
      return 'en-US';
    },
    commandLine: { getSwitchValue: () => '' },
  },
  BrowserWindow: class {}, ipcMain: {}, nativeTheme: {}, Notification: {}, screen: {}, shell: {}, safeStorage: {},
}));

const realPlatform = process.platform;
// macOS falls through to the region locale when `defaults` has no clock toggle (absent here).
Object.defineProperty(process, 'platform', { value: 'darwin' });
afterAll(() => Object.defineProperty(process, 'platform', { value: realPlatform }));

it('reads the OS clock only after app ready, so importing window modules never touches ready-only APIs', async () => {
  const { rendererPreferences } = await import('./window');
  await import('./notifier');
  const { systemHourCycle } = await import('./hourCycle');
  expect(() => systemHourCycle()).toThrow(/before app ready/);
  electron.ready = true;
  expect(rendererPreferences().additionalArguments).toEqual([`${HOUR_CYCLE_ARG}h12`]);
});
