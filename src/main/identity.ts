import { app } from 'electron';
import path from 'node:path';
import { APP_NAME, IS_DEV_BUILD } from '@shared/app';

// Imported first by index.ts: the data folder must be set before anything reads it.
// `pnpm dev` reads package.json's production name, so the dev build renames itself.
if (IS_DEV_BUILD && app.getName() !== APP_NAME) {
  app.setName(APP_NAME);
  app.setPath('userData', path.join(app.getPath('appData'), APP_NAME));
}
