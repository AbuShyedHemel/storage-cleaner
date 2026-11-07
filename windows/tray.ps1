# Storage Cleaner for Windows: system tray app.
#
# Shows live memory use as a tray icon, starts the local server (server.mjs)
# on a random port with a random token, and opens the interface in its own
# Edge app window. Right-click the icon for Free up memory, Run as
# administrator, Start with Windows and Quit.
#
#   powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File tray.ps1 [-Open]

param([switch]$Open, [switch]$Handover)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, Microsoft.VisualBasic
[System.Windows.Forms.Application]::EnableVisualStyles()

Add-Type -Namespace SC -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr h);
[DllImport("shell32.dll", SetLastError = true)] public static extern void SetCurrentProcessExplicitAppUserModelID([MarshalAs(UnmanagedType.LPWStr)] string id);
'@
[SC.Native]::SetCurrentProcessExplicitAppUserModelID('StorageCleaner.Windows')

$Here = $PSScriptRoot
$Data = Join-Path $env:LOCALAPPDATA 'Storage Cleaner'
$AppProfile = Join-Path $Data 'window'
$SessionFile = Join-Path $Data 'session.json'
$ServerLog = Join-Path $Data 'server.log'
$StartupLink = Join-Path ([Environment]::GetFolderPath('Startup')) 'Storage Cleaner.lnk'
New-Item -ItemType Directory -Force $Data | Out-Null
$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

function Open-Window([string]$url) {
  $edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") |
    Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if ($edge) {
    # A private Edge profile so the window has no tabs or toolbar and is not
    # mistaken for the user's own Edge when clearing Edge's cache.
    Start-Process $edge -ArgumentList @("--app=$url", "--user-data-dir=`"$AppProfile`"", '--window-size=1180,840', '--no-first-run', '--no-default-browser-check', '--disable-features=Translate')
  } else {
    Start-Process $url
  }
}

# ---- single instance: a second launch just opens the window ----
$mutex = New-Object System.Threading.Mutex($false, 'Local\StorageCleanerTray')
$owned = $false
# Already running: open its window right away. Only a hand-over to an elevated
# copy waits for the old instance to quit first.
try { $owned = $mutex.WaitOne($(if ($Handover) { 15000 } else { 0 })) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
if (-not $owned) {
  try { $s = Get-Content $SessionFile -Raw | ConvertFrom-Json; Open-Window $s.url } catch { }
  exit
}

function Find-Node {
  $c = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe", "$env:NVM_SYMLINK\node.exe",
                   "$env:LOCALAPPDATA\Volta\bin\node.exe", "$env:USERPROFILE\.bun\bin\bun.exe")) {
    if ($p -and (Test-Path $p)) { return $p }
  }
  $b = Get-Command bun.exe -ErrorAction SilentlyContinue
  if ($b) { return $b.Source }
  return $null
}

$Node = Find-Node
if (-not $Node) {
  [System.Windows.Forms.MessageBox]::Show("Node.js was not found.`n`nInstall it from https://nodejs.org (LTS) or with:  winget install OpenJS.NodeJS.LTS`nthen open Storage Cleaner again.", 'Storage Cleaner', 'OK', 'Warning') | Out-Null
  exit 1
}

# ---- icon drawing ----
function New-TrayIcon([string]$text, [System.Drawing.Color]$color) {
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $r = 8
  $path.AddArc(0, 0, $r * 2, $r * 2, 180, 90); $path.AddArc(31 - $r * 2, 0, $r * 2, $r * 2, 270, 90)
  $path.AddArc(31 - $r * 2, 31 - $r * 2, $r * 2, $r * 2, 0, 90); $path.AddArc(0, 31 - $r * 2, $r * 2, $r * 2, 90, 90); $path.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush $color), $path)
  $size = if ($text.Length -ge 3) { 13 } else { 17 }
  $font = New-Object System.Drawing.Font('Segoe UI', $size, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
  $g.DrawString($text, $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 0, 1, 32, 32), $fmt)
  $g.Dispose()
  $h = $bmp.GetHicon()
  $bmp.Dispose()
  return [System.Drawing.Icon]::FromHandle($h)
}

$Blue = [System.Drawing.Color]::FromArgb(0, 103, 192)
$Amber = [System.Drawing.Color]::FromArgb(202, 122, 0)
$Red = [System.Drawing.Color]::FromArgb(196, 43, 28)
$Grey = [System.Drawing.Color]::FromArgb(110, 110, 110)

$tray = New-Object System.Windows.Forms.NotifyIcon
$script:iconHandle = $null
function Set-Icon([string]$text, $color, [string]$tip) {
  $icon = New-TrayIcon $text $color
  $old = $script:iconHandle
  $tray.Icon = $icon
  $script:iconHandle = $icon.Handle
  if ($old) { [SC.Native]::DestroyIcon($old) | Out-Null }
  if ($tip.Length -gt 63) { $tip = $tip.Substring(0, 63) }
  $tray.Text = $tip
}
Set-Icon '...' $Grey 'Storage Cleaner: starting...'
$tray.Visible = $true

# ---- server ----
$script:server = $null
$script:url = $null
$script:token = $null
$script:port = 0

function Get-FreePort {
  $l = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback), 0
  $l.Start(); $p = $l.LocalEndpoint.Port; $l.Stop(); return $p
}

function Start-Server {
  $script:port = Get-FreePort
  $script:token = -join ((1..32) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
  $script:url = "http://127.0.0.1:$($script:port)/?t=$($script:token)"
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "$env:SystemRoot\System32\cmd.exe"
  # cmd only redirects output to the log; its exit code is node's.
  $psi.Arguments = "/d /s /c `"`"$Node`" `"$Here\server.mjs`" > `"$ServerLog`" 2>&1`""
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.WorkingDirectory = $Here
  $psi.EnvironmentVariables['PORT'] = "$($script:port)"
  $psi.EnvironmentVariables['TOKEN'] = $script:token
  $psi.EnvironmentVariables['NO_OPEN'] = '1'
  $psi.EnvironmentVariables['APP_PROFILE'] = $AppProfile
  $psi.EnvironmentVariables['LOG_DIR'] = $Data
  $script:server = [System.Diagnostics.Process]::Start($psi)
  @{ url = $script:url; pid = $PID } | ConvertTo-Json | Set-Content -Encoding UTF8 $SessionFile
}

function Stop-Server {
  if ($script:server -and -not $script:server.HasExited) {
    & taskkill.exe /pid $script:server.Id /t /f 2>$null | Out-Null
  }
}

function Wait-Server {
  # The first launch compiles the native helper, which takes a few seconds.
  for ($i = 0; $i -lt 120; $i++) {
    if ($script:server.HasExited) { return $false }
    try {
      Invoke-RestMethod -Uri "http://127.0.0.1:$($script:port)/api/live" -Headers @{ 'X-Token' = $script:token } -TimeoutSec 2 | Out-Null
      return $true
    } catch { Start-Sleep -Milliseconds 500 }
  }
  return $false
}

function Api([string]$path, $body) {
  $req = @{ Uri = "http://127.0.0.1:$($script:port)/api/$path"; Headers = @{ 'X-Token' = $script:token }; TimeoutSec = 120 }
  if ($null -ne $body) { $req.Method = 'Post'; $req.ContentType = 'application/json'; $req.Body = ($body | ConvertTo-Json -Compress) }
  return Invoke-RestMethod @req
}

function Format-Size([double]$b) {
  if ($b -ge 1GB) { return '{0:N1} GB' -f ($b / 1GB) }
  if ($b -ge 1MB) { return '{0:N0} MB' -f ($b / 1MB) }
  return '{0:N0} KB' -f ($b / 1KB)
}

function Quit-App {
  $timer.Stop()
  Stop-Server
  $tray.Visible = $false
  $tray.Dispose()
  try { $mutex.ReleaseMutex() } catch { }
  [System.Windows.Forms.Application]::Exit()
}

function Restart-Elevated {
  try {
    $timer.Stop()
    Stop-Server
    $tray.Visible = $false
    try { $mutex.ReleaseMutex() } catch { }
    Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" -Open -Handover"
    $tray.Dispose()
    [System.Windows.Forms.Application]::Exit()
  } catch {
    # UAC was cancelled: carry on as before.
    $null = $mutex.WaitOne(0)
    Start-Server; $null = Wait-Server
    $tray.Visible = $true
    $timer.Start()
  }
}

function Set-StartWithWindows([bool]$on) {
  if ($on) {
    $sh = New-Object -ComObject WScript.Shell
    $lnk = $sh.CreateShortcut($StartupLink)
    $lnk.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`""
    $lnk.WorkingDirectory = $Here
    $lnk.WindowStyle = 7
    $ico = Join-Path $Data 'app.ico'
    if (Test-Path $ico) { $lnk.IconLocation = $ico }
    $lnk.Description = 'Storage Cleaner: memory and storage cleaner for Windows'
    $lnk.Save()
  } elseif (Test-Path $StartupLink) {
    Remove-Item $StartupLink -Force
  }
}

# ---- menu ----
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miOpen = $menu.Items.Add('Open Storage Cleaner')
$miOpen.Font = New-Object System.Drawing.Font($miOpen.Font, [System.Drawing.FontStyle]::Bold)
$miOpen.add_Click({ Open-Window $script:url })
$miFree = $menu.Items.Add('Free up memory')
$miFree.add_Click({
  try {
    $r = Api 'memory/optimize' @{ deep = $true }
    $tray.ShowBalloonTip(4000, 'Memory freed', "Freed $(Format-Size $r.freed). Memory is now $($r.mem.load)% used.", 'Info')
  } catch { $tray.ShowBalloonTip(4000, 'Storage Cleaner', $_.Exception.Message, 'Warning') }
})
$null = $menu.Items.Add('-')
if (-not $IsAdmin) {
  $miAdmin = $menu.Items.Add('Restart as administrator')
  $miAdmin.add_Click({ Restart-Elevated })
}
$miBoot = New-Object System.Windows.Forms.ToolStripMenuItem 'Start with Windows'
$miBoot.Checked = Test-Path $StartupLink
$miBoot.add_Click({ Set-StartWithWindows (-not $miBoot.Checked); $miBoot.Checked = Test-Path $StartupLink })
$null = $menu.Items.Add($miBoot)
$miLogs = $menu.Items.Add('Open log folder')
$miLogs.add_Click({ Start-Process explorer.exe $Data })
$miRestart = $menu.Items.Add('Restart server')
$miRestart.add_Click({ Stop-Server; Start-Server; if (Wait-Server) { Update-Status } })
$null = $menu.Items.Add('-')
$miQuit = $menu.Items.Add('Quit')
$miQuit.add_Click({ Quit-App })
$tray.ContextMenuStrip = $menu
$tray.add_MouseClick({ param($s, $e) if ($e.Button -eq 'Left') { Open-Window $script:url } })

# ---- live status ----
$info = New-Object Microsoft.VisualBasic.Devices.ComputerInfo
$script:lastText = ''
function Update-Status {
  if ($script:server -and $script:server.HasExited) {
    if ($script:server.ExitCode -eq 42) { Quit-App; return } # handed over to an elevated copy
    if ($script:lastText -ne '!') { Set-Icon '!' $Red 'Storage Cleaner: server stopped (right-click > Restart server)'; $script:lastText = '!' }
    return
  }
  $total = [double]$info.TotalPhysicalMemory
  $load = [int][Math]::Round((1 - $info.AvailablePhysicalMemory / $total) * 100)
  $sys = New-Object System.IO.DriveInfo ($env:SystemDrive)
  $tip = "Storage Cleaner$(if ($IsAdmin) { ' (admin)' })`nMemory $load% used - $($env:SystemDrive) $(Format-Size $sys.AvailableFreeSpace) free"
  $text = "$load"
  if ($text -ne $script:lastText) {
    $color = if ($load -ge 85) { $Red } elseif ($load -ge 70) { $Amber } else { $Blue }
    Set-Icon $text $color $tip
    $script:lastText = $text
  } else { $tray.Text = $tip.Substring(0, [Math]::Min(63, $tip.Length)) }
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.add_Tick({ Update-Status })

Start-Server
if (-not (Wait-Server)) {
  $msg = (Get-Content $ServerLog -Tail 15 -ErrorAction SilentlyContinue) -join "`n"
  Set-Icon '!' $Red 'Storage Cleaner: could not start'
  [System.Windows.Forms.MessageBox]::Show("The Storage Cleaner server did not start.`n`n$msg", 'Storage Cleaner', 'OK', 'Error') | Out-Null
  Quit-App
  exit 1
}
Update-Status
$timer.Start()
if ($Open) { Open-Window $script:url }
else { $tray.ShowBalloonTip(3000, 'Storage Cleaner', 'Running in the tray. Click the icon to open it.', 'Info') }

[System.Windows.Forms.Application]::Run()
Stop-Server
