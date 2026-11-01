// `pnpm dev:shortcut`: adds a "Spillway Dev" launcher that runs `pnpm dev` from this repo.
// Windows: Start Menu shortcut with the dev app ID and the large tile logo. macOS: ~/Applications/Spillway Dev.app.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appIdentity } from '../src/shared/app.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { id, name } = appIdentity(true);

function windowsShortcut() {
  if (!process.env.APPDATA || !process.env.SystemRoot) throw new Error('APPDATA and SystemRoot must be set');
  const file = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${name}.lnk`);
  // conhost --headless runs PowerShell without a console window.
  const target = path.join(process.env.SystemRoot, 'System32', 'conhost.exe');
  const args = `--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${path.join(root, 'scripts', 'dev-launch.ps1')}"`;
  // Windows PowerShell 5 ships with Windows, so no extra runtime is needed.
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'dev-shortcut.ps1'),
    '-Path', file, '-Target', target, '-Arguments', args, '-WorkingDirectory', root, '-Icon', path.join(root, 'resources', 'icon.ico'),
    '-AppId', id, '-TileManifest', path.join(root, 'resources', 'Spillway.VisualElementsManifest.xml')], { stdio: 'inherit' });
  return file;
}

function macApp() {
  const bundle = path.join(homedir(), 'Applications', `${name}.app`);
  const contents = path.join(bundle, 'Contents');
  rmSync(bundle, { recursive: true, force: true });
  mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  mkdirSync(path.join(contents, 'Resources'), { recursive: true });
  const executable = 'spillway-dev';
  // LSUIElement: the launcher has no Dock icon; the Electron app it starts shows its own.
  writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>${name}</string>
  <key>CFBundleIdentifier</key><string>${id}.launcher</string>
  <key>CFBundleExecutable</key><string>${executable}</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
</dict></plist>
`);
  const quotedRoot = `'${root.replaceAll("'", `'\''`)}'`;
  // A login shell loads the PATH that finds pnpm; Finder starts apps without it.
  writeFileSync(path.join(contents, 'MacOS', executable), `#!/bin/zsh -l
cd ${quotedRoot} || exit 1
unset ELECTRON_RUN_AS_NODE
exec pnpm dev >"\${TMPDIR:-/tmp}/spillway-dev.log" 2>&1
`);
  chmodSync(path.join(contents, 'MacOS', executable), 0o755);
  execFileSync('sips', ['-s', 'format', 'icns', path.join(root, 'resources', 'icon-1024.png'), '--out', path.join(contents, 'Resources', 'icon.icns')], { stdio: 'ignore' });
  return bundle;
}

if (process.platform === 'win32') console.log(`dev-shortcut: wrote ${windowsShortcut()}`);
else if (process.platform === 'darwin') console.log(`dev-shortcut: wrote ${macApp()}`);
else throw new Error('dev-shortcut supports Windows and macOS');
