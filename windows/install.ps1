# Storage Cleaner for Windows: installer.
#
# Adds Storage Cleaner to the Start menu (and optionally the desktop and
# sign-in), with its own icon. Nothing is copied: the shortcuts run the files
# in this folder, so keep the folder where it is (or run this again after
# moving it).
#
#   powershell -ExecutionPolicy Bypass -File install.ps1 [-Desktop] [-StartWithWindows] [-Uninstall]

param([switch]$Desktop, [switch]$StartWithWindows, [switch]$Uninstall)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$Here = $PSScriptRoot
$Data = Join-Path $env:LOCALAPPDATA 'Storage Cleaner'
$Ico = Join-Path $Data 'app.ico'
$Tray = Join-Path $Here 'tray.ps1'
$Links = @(
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'Storage Cleaner.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Storage Cleaner.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Startup')) 'Storage Cleaner.lnk')
)

if ($Uninstall) {
  # Stop the tray app (and the server it started) if it is running.
  Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
    Where-Object { $_.CommandLine -like '*tray.ps1*' } |
    ForEach-Object { & taskkill.exe /pid $_.ProcessId /t /f 2>$null | Out-Null }
  Get-Process StorageCleaner -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Milliseconds 500
  foreach ($l in $Links) { if (Test-Path $l) { Remove-Item $l -Force; Write-Host "Removed $l" } }
  Remove-Item 'HKCU:\Software\Storage Cleaner' -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path $Data) { Remove-Item $Data -Recurse -Force -ErrorAction SilentlyContinue; Write-Host "Removed $Data" }
  Write-Host "`nStorage Cleaner was removed. Delete this folder to remove the program files too."
  return
}

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue) -and -not (Test-Path "$env:ProgramFiles\nodejs\node.exe")) {
  Write-Warning "Node.js is not installed. Install it first, then run this again:`n    winget install OpenJS.NodeJS.LTS"
}

New-Item -ItemType Directory -Force $Data | Out-Null

# App icon and native window (downloads the WebView2 SDK once). If this fails,
# Storage Cleaner still works and opens in an Edge app window instead.
try {
  $exe = & (Join-Path $Here 'build-window.ps1')
  Write-Host "Built $exe"
} catch {
  Write-Warning "Could not build the app window ($($_.Exception.Message)). Storage Cleaner will open in an Edge window."
}

function New-Link([string]$path, [string]$extra, [string]$hotkey = '') {
  $sh = New-Object -ComObject WScript.Shell
  $lnk = $sh.CreateShortcut($path)
  $lnk.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Tray`" $extra".Trim()
  $lnk.WorkingDirectory = $Here
  $lnk.WindowStyle = 7
  $lnk.IconLocation = $Ico
  $lnk.Description = 'Free memory, clean storage and speed up Windows'
  if ($hotkey) { $lnk.Hotkey = $hotkey }
  $lnk.Save()
  Write-Host "Created $path$(if ($hotkey) { "  (shortcut key: $hotkey)" })"
}

# Ctrl+Alt+S opens the app from anywhere. Windows reads shortcut keys from
# Start menu shortcuts, so only that one carries it.
New-Link $Links[0] '-Open' 'CTRL+ALT+S'
if ($Desktop) { New-Link $Links[1] '-Open' }
if ($StartWithWindows) { New-Link $Links[2] '' }

Write-Host "`nStorage Cleaner is installed. Press Ctrl+Alt+S, open it from the Start menu, or run:"
Write-Host "    powershell -ExecutionPolicy Bypass -File `"$Tray`" -Open"
