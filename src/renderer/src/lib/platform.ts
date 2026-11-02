/** Fixed for the app's lifetime, so plain constants (not signals). */
export const isMac = window.api.platform === 'darwin';
export const OS_NAME = isMac ? 'macOS' : window.api.platform === 'linux' ? 'Linux' : 'Windows';
/** Where the app's status icons live. */
export const TRAY_NAME = isMac ? 'menu bar' : 'tray';
export const TASKBAR_NAME = isMac ? 'Dock' : 'taskbar';
export const DEFAULT_SHELL = window.api.platform === 'win32' ? 'powershell' : 'bash';
export const TRAY_ICONS_HELP = isMac
  ? 'One menu bar icon per entry below. Cmd-drag an icon to reorder it.'
  : window.api.platform === 'linux'
    ? 'One tray icon per entry below. Your desktop needs a tray host; icon placement depends on the desktop.'
    : 'One notification-area icon per entry below. If Windows hides new ones under ^, drag them onto the taskbar.';
