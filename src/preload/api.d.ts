import type { NoticeBridge } from '@cujuju/electron-notices';
import type { DesktopApi } from '../shared/ipc';

declare global {
  interface Window {
    api: DesktopApi;
    notices: NoticeBridge;
  }
}

export {};
