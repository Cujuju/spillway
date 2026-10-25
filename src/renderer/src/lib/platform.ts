/** Fixed for the app's lifetime, so plain constants (not signals). */
export const isMac = window.api.platform === 'darwin';
export const OS_NAME = isMac ? 'macOS' : 'Windows';
/** Where the app's status icons live. */
export const TRAY_NAME = isMac ? 'menu bar' : 'tray';
export const TASKBAR_NAME = isMac ? 'Dock' : 'taskbar';
