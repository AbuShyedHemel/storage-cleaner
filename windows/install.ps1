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
  foreach ($l in $Links) { if (Test-Path $l) { Remove-Item $l -Force; Write-Host "Removed $l" } }
  if (Test-Path $Data) { Remove-Item $Data -Recurse -Force -ErrorAction SilentlyContinue; Write-Host "Removed $Data" }
  Write-Host "`nStorage Cleaner was removed. Delete this folder to remove the program files too."
  return
}

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue) -and -not (Test-Path "$env:ProgramFiles\nodejs\node.exe")) {
  Write-Warning "Node.js is not installed. Install it first, then run this again:`n    winget install OpenJS.NodeJS.LTS"
}

New-Item -ItemType Directory -Force $Data | Out-Null

# App icon: a 256 px PNG wrapped in an .ico container.
function New-AppIcon([string]$out) {
  $s = 256
  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $rect = New-Object System.Drawing.Rectangle 8, 8, ($s - 16), ($s - 16)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.Color]::FromArgb(10, 132, 255)), ([System.Drawing.Color]::FromArgb(94, 92, 230)), 45
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $r = 56
  $p.AddArc(8, 8, $r, $r, 180, 90); $p.AddArc($s - 8 - $r, 8, $r, $r, 270, 90)
  $p.AddArc($s - 8 - $r, $s - 8 - $r, $r, $r, 0, 90); $p.AddArc(8, $s - 8 - $r, $r, $r, 90, 90); $p.CloseFigure()
  $g.FillPath($brush, $p)
  # Sparkle: a four-point star plus a small one.
  function Star($cx, $cy, $R, $rr) {
    $pts = for ($i = 0; $i -lt 8; $i++) {
      $a = [Math]::PI / 4 * $i - [Math]::PI / 2
      $len = if ($i % 2 -eq 0) { $R } else { $rr }
      New-Object System.Drawing.PointF ($cx + $len * [Math]::Cos($a)), ($cy + $len * [Math]::Sin($a))
    }
    $g.FillPolygon([System.Drawing.Brushes]::White, [System.Drawing.PointF[]]$pts)
  }
  Star 112 120 78 20
  Star 186 186 34 9
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $png = $ms.ToArray()
  $bmp.Dispose()
  $fs = [System.IO.File]::Create($out)
  $w = New-Object System.IO.BinaryWriter $fs
  $w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]1)          # ICONDIR
  $w.Write([Byte]0); $w.Write([Byte]0); $w.Write([Byte]0); $w.Write([Byte]0) # 256x256, no palette
  $w.Write([UInt16]1); $w.Write([UInt16]32); $w.Write([UInt32]$png.Length); $w.Write([UInt32]22)
  $w.Write($png)
  $w.Close()
}
New-AppIcon $Ico

function New-Link([string]$path, [string]$extra) {
  $sh = New-Object -ComObject WScript.Shell
  $lnk = $sh.CreateShortcut($path)
  $lnk.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Tray`" $extra".Trim()
  $lnk.WorkingDirectory = $Here
  $lnk.WindowStyle = 7
  $lnk.IconLocation = $Ico
  $lnk.Description = 'Free memory, clean storage and speed up Windows'
  $lnk.Save()
  Write-Host "Created $path"
}

New-Link $Links[0] '-Open'
if ($Desktop) { New-Link $Links[1] '-Open' }
if ($StartWithWindows) { New-Link $Links[2] '' }

Write-Host "`nStorage Cleaner is installed. Open it from the Start menu, or run:"
Write-Host "    powershell -ExecutionPolicy Bypass -File `"$Tray`" -Open"
