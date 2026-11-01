// Electron main run by scripts/dev-shortcut.mjs: writes the Start Menu shortcut with Spillway Dev's app ID.
const { app, shell } = require('electron');
const [file, target, args, cwd, icon, appUserModelId] = process.argv.slice(-6);
// 'create' overwrites an existing shortcut.
const ok = shell.writeShortcutLink(file, 'create', { target, args, cwd, icon, iconIndex: 0, appUserModelId, description: 'Spillway Dev, run from the repo' });
app.exit(ok ? 0 : 1);
