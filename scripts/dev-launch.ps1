# Start Menu target made by `pnpm dev:shortcut`: runs Spillway Dev from this repo with `pnpm dev`.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$log = Join-Path $env:TEMP 'spillway-dev-shortcut.log'

function Get-AppProcess {
    Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$repo\node_modules\*" }
}

# Held while `pnpm dev` runs; with it or a running app, a click focuses the app instead of starting another build.
$lock = [Threading.Mutex]::new($false, 'Local\SpillwayDevLauncher')
try { $owned = $lock.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owned = $true }
if (-not $owned -or (Get-AppProcess)) {
    $window = Get-AppProcess | Where-Object MainWindowHandle -ne 0 | Select-Object -First 1
    if ($window) { [void](New-Object -ComObject WScript.Shell).AppActivate($window.Id) }
    exit
}
try {
    # Inherited from an Electron-hosted parent, it makes electron.exe run as plain Node.
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    Set-Location -LiteralPath $repo
    # The headless console has no window; the log is the only place errors show.
    # Through cmd: Windows PowerShell treats pnpm's stderr lines as errors and stops the script.
    cmd.exe /d /c "pnpm dev > `"$log`" 2>&1"
} finally {
    $lock.ReleaseMutex()
}
