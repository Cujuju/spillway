// `pnpm dev:shortcut`: adds a "Spillway Dev" launcher that runs `pnpm dev` from this repo.
// Windows: Start Menu shortcut with the dev app ID and tile logo. macOS: ~/Applications/Spillway Dev.app.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
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
    '-AppId', id, '-TileManifest', path.join(root, 'resources', 'Spillway.VisualElementsManifest.xml'),
    // The `electron` package exports its exe's real path, the one `pnpm dev` runs.
    '-ElectronExe', createRequire(import.meta.url)('electron') as string], { stdio: 'inherit' });
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
  writeFileSync(path.join(contents, 'MacOS', executable), macLauncherScript(root));
  // sips can't write a 1024px .icns on macOS 26, so build an iconset and let iconutil pack it.
  const iconset = path.join(mkdtempSync(path.join(tmpdir(), 'spillway-dev-')), 'icon.iconset');
  mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const [scale, suffix] of [[1, ''], [2, '@2x']] as const) {
      const px = String(size * scale);
      execFileSync('sips', ['-z', px, px, path.join(root, 'resources', 'icon-1024.png'), '--out', path.join(iconset, `icon_${size}x${size}${suffix}.png`)], { stdio: 'ignore' });
    }
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(contents, 'Resources', 'icon.icns')], { stdio: 'inherit' });
  rmSync(path.dirname(iconset), { recursive: true, force: true });
  return bundle;
}

/** One POSIX single-quoted word: each `'` closes the quote, adds an escaped `'`, and reopens it. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", String.raw`'\''`)}'`;

/** The macOS launcher: a login shell loads the PATH that finds pnpm; Finder starts apps without it. */
export function macLauncherScript(repoRoot: string): string {
  // The launcher exits once `pnpm dev` is started: while it ran, macOS would only re-activate it on the next click.
  return `#!/bin/zsh -l
repo=${shellQuote(repoRoot)}
pidfile="\${TMPDIR:-/tmp}/spillway-dev.pid"
# A running app: opening its bundle again makes macOS send it a reopen, which shows the window.
for exe in \${(f)"$(ps -axo comm=)"}; do
  if [[ $exe == "$repo"/node_modules/*/Electron.app/Contents/MacOS/Electron ]]; then
    exec open "\${exe%/Contents/MacOS/Electron}"
  fi
done
# Still building: leave it alone.
[[ -f $pidfile ]] && kill -0 "$(<$pidfile)" 2>/dev/null && exit 0
cd "$repo" || exit 1
unset ELECTRON_RUN_AS_NODE
nohup pnpm dev >"\${TMPDIR:-/tmp}/spillway-dev.log" 2>&1 &
echo $! >"$pidfile"
`;
}

// Imported by its test: only a direct run writes a launcher.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform === 'win32') console.log(`dev-shortcut: wrote ${windowsShortcut()}`);
  else if (process.platform === 'darwin') console.log(`dev-shortcut: wrote ${macApp()}`);
  else throw new Error('dev-shortcut supports Windows and macOS');
}
