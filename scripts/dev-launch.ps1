# Start Menu target made by `pnpm dev:shortcut`: runs Spillway Dev from this repo with `pnpm dev`.
# -AfterExit: started by the app's Restart; waits for the old app and its `pnpm dev` to exit first.
param(
    [switch]$AfterExit,
    [string]$TaskName = 'SpillwayDev'
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
# Covers the old app draining activity and stopping the proxy, whose binary stays locked until it exits.
$restartWaitSeconds = 60
$restartPollMs = 200
$interactiveDesktop = 'Default'
$launcherMutexName = 'Local\SpillwayDevLauncher'
$log = Join-Path $env:TEMP 'spillway-dev-shortcut.log'

function Get-CurrentDesktopName {
    if (-not ('SpillwayDevDesktop.Native' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace SpillwayDevDesktop {
    public static class Native {
        const int UOI_NAME = 2;
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
        [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetThreadDesktop(uint threadId);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool GetUserObjectInformationW(IntPtr obj, int index, StringBuilder info, uint length, out uint needed);

        public static string CurrentDesktopName() {
            IntPtr desktop = GetThreadDesktop(GetCurrentThreadId());
            if (desktop == IntPtr.Zero) return string.Empty;
            var buffer = new StringBuilder(256);
            uint needed;
            return GetUserObjectInformationW(desktop, UOI_NAME, buffer, (uint)(buffer.Capacity * 2), out needed)
                ? buffer.ToString()
                : string.Empty;
        }
    }
}
'@
    }
    [SpillwayDevDesktop.Native]::CurrentDesktopName()
}

# Electron recreates its notification shortcut visible if it was deleted; hidden, Start lists "Spillway Dev" (dev-shortcut.ps1).
function Hide-ElectronShortcut {
    $exe = Join-Path $repo 'node_modules\electron\dist\electron.exe'
    if (-not (Test-Path -LiteralPath $exe)) { return }
    $name = (Get-Item -LiteralPath $exe).VersionInfo.ProductName
    $file = Join-Path ([Environment]::GetFolderPath('Programs')) "$name.lnk"
    $item = Get-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    if (-not $item -or ($item.Attributes -band [IO.FileAttributes]::Hidden)) { return }
    if ((New-Object -ComObject WScript.Shell).CreateShortcut($file).TargetPath -like "$repo\node_modules\*") {
        $item.Attributes = $item.Attributes -bor [IO.FileAttributes]::Hidden
    }
}

function Get-AppProcess {
    Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$repo\node_modules\*" }
}

function Show-RunningApp {
    $window = Get-AppProcess | Where-Object MainWindowHandle -ne 0 | Select-Object -First 1
    if ($window) { [void](New-Object -ComObject WScript.Shell).AppActivate($window.Id); return }
    # Hidden in the tray: trigger Electron's second-instance handler so the running app shows its window.
    $main = Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" |
        Where-Object { $_.ExecutablePath -like "$repo\node_modules\*" -and $_.CommandLine -notmatch '--type=' } |
        Select-Object -First 1
    if ($main) {
        Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
        Start-Process -FilePath $main.ExecutablePath -ArgumentList "`"$repo`"" -WorkingDirectory $repo
    }
}

# Non-Default desktops (e.g. agent sandboxes like WinSta0\exebox-*) have no user shell or tray;
# hand off to the registered interactive Scheduled Task so the app starts on WinSta0\Default.
$desktop = Get-CurrentDesktopName
if ($desktop -ne $interactiveDesktop) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) {
        [Console]::Error.WriteLine("Cannot launch Spillway Dev from non-interactive desktop '$desktop': Scheduled Task '$TaskName' is not registered. Run 'pnpm dev:shortcut' once to register it.")
        exit 1
    }
    if ($AfterExit) {
        $waitLock = [Threading.Mutex]::new($false, $launcherMutexName)
        $deadline = (Get-Date).AddSeconds($restartWaitSeconds)
        $acquired = $false
        try {
            try { $acquired = $waitLock.WaitOne([TimeSpan]::FromSeconds($restartWaitSeconds)) } catch [Threading.AbandonedMutexException] { $acquired = $true }
            while ((Get-AppProcess) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds $restartPollMs }
        } finally {
            if ($acquired) { $waitLock.ReleaseMutex() }
            $waitLock.Dispose()
        }
    }
    Start-ScheduledTask -TaskName $TaskName
    exit 0
}

# Held while `pnpm dev` runs; with it or a running app, a click focuses the app instead of starting another build.
$lock = [Threading.Mutex]::new($false, $launcherMutexName)
$wait = if ($AfterExit) { [TimeSpan]::FromSeconds($restartWaitSeconds) } else { [TimeSpan]::Zero }
$deadline = (Get-Date) + $wait
try { $owned = $lock.WaitOne($wait) } catch [Threading.AbandonedMutexException] { $owned = $true }
# An app started from a terminal holds no lock, so also wait for its process.
while ($AfterExit -and $owned -and (Get-AppProcess) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds $restartPollMs }
if (-not $owned -or (Get-AppProcess)) {
    Show-RunningApp
    if ($owned) { $lock.ReleaseMutex() }
    exit
}
try {
    # Inherited from an Electron-hosted parent, it makes electron.exe run as plain Node.
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    # Always expose loopback CDP on the dev build so tools can inspect live state unless overridden.
    if (-not $env:REMOTE_DEBUGGING_PORT) { $env:REMOTE_DEBUGGING_PORT = '9333' }
    Set-Location -LiteralPath $repo
    Hide-ElectronShortcut
    # The headless console has no window; the log is the only place errors show.
    # Through cmd: Windows PowerShell treats pnpm's stderr lines as errors and stops the script.
    cmd.exe /d /c "pnpm dev > `"$log`" 2>&1"
} finally {
    $lock.ReleaseMutex()
}
