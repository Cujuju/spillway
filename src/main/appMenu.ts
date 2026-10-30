import { app, Menu } from 'electron';
import { APP_NAME } from '@shared/app';

/** macOS menu bar: Electron's default menus, except About opens Settings → About instead of the native panel. Windows hides the menu bar, so it keeps the default. */
export function installAppMenu(openAbout: () => void): void {
  if (process.platform !== 'darwin') return;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { label: `About ${APP_NAME}`, click: openAbout },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { role: 'fileMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );
}
