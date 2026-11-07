# Storage Cleaner for Windows: builds the native app window (app.cs).
#
# Downloads Microsoft's WebView2 SDK from nuget.org once (checksum pinned,
# signatures checked), keeps only the three DLLs it needs, and compiles
# app.cs with the C# compiler that ships with Windows. Also creates the app
# icon. Prints the path of StorageCleaner.exe; does nothing if it is current.
#
#   powershell -ExecutionPolicy Bypass -File build-window.ps1

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Drawing, System.IO.Compression.FileSystem

$Here = $PSScriptRoot
$Data = Join-Path $env:LOCALAPPDATA 'Storage Cleaner'
$Bin = Join-Path $Data 'app'
$Cache = Join-Path $Data 'cache'
$Ico = Join-Path $Data 'app.ico'
$Exe = Join-Path $Bin 'StorageCleaner.exe'

$WebView2Version = '1.0.3912.50'
$WebView2Sha256 = '8DD696301D8E5AD8389F26B636329BBF35754B793974E82168B1F6DDA234EB07'

New-Item -ItemType Directory -Force $Data, $Bin, $Cache | Out-Null

# ---- app icon: a 256 px PNG wrapped in an .ico container ----
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
  # Store 256, 48, 32 and 16 px images so Explorer and the taskbar have sharp sizes.
  $images = foreach ($size in 256, 48, 32, 16) {
    $b = New-Object System.Drawing.Bitmap $size, $size
    $gg = [System.Drawing.Graphics]::FromImage($b)
    $gg.InterpolationMode = 'HighQualityBicubic'; $gg.SmoothingMode = 'AntiAlias'
    $gg.DrawImage($bmp, 0, 0, $size, $size); $gg.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $b.Dispose()
    , @($size, $ms.ToArray())
  }
  $bmp.Dispose()
  $fs = [System.IO.File]::Create($out)
  $w = New-Object System.IO.BinaryWriter $fs
  $w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$images.Count)
  $offset = 6 + 16 * $images.Count
  foreach ($im in $images) {
    $dim = if ($im[0] -ge 256) { 0 } else { $im[0] }
    $w.Write([Byte]$dim); $w.Write([Byte]$dim); $w.Write([Byte]0); $w.Write([Byte]0)
    $w.Write([UInt16]1); $w.Write([UInt16]32); $w.Write([UInt32]$im[1].Length); $w.Write([UInt32]$offset)
    $offset += $im[1].Length
  }
  foreach ($im in $images) { $w.Write($im[1]) }
  $w.Close()
}

$IconVersion = '2'
$IconStamp = Join-Path $Data 'app.ico.v'
if (-not (Test-Path $Ico) -or (Get-Content $IconStamp -ErrorAction SilentlyContinue) -ne $IconVersion) {
  New-AppIcon $Ico
  Set-Content $IconStamp $IconVersion
}

# ---- up to date? ----
$src = Join-Path $Here 'app.cs'
$sha = [System.Security.Cryptography.SHA256]::Create()
$stamp = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($src))).Replace('-', '').Substring(0, 16) + "-$WebView2Version-$IconVersion"
$StampFile = Join-Path $Bin 'build.txt'
if ((Test-Path $Exe) -and (Get-Content $StampFile -ErrorAction SilentlyContinue) -eq $stamp) { $Exe; return }

# ---- WebView2 SDK ----
$arch = switch ($env:PROCESSOR_ARCHITECTURE) { 'ARM64' { 'arm64' } 'x86' { 'x86' } default { 'x64' } }
$pkg = Join-Path $Cache "microsoft.web.webview2.$WebView2Version.nupkg"
if (-not (Test-Path $pkg) -or (Get-FileHash $pkg -Algorithm SHA256).Hash -ne $WebView2Sha256) {
  $url = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$WebView2Version/microsoft.web.webview2.$WebView2Version.nupkg"
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest $url -OutFile "$pkg.part" -UseBasicParsing
  if ((Get-FileHash "$pkg.part" -Algorithm SHA256).Hash -ne $WebView2Sha256) {
    Remove-Item "$pkg.part" -Force
    throw 'The downloaded WebView2 SDK does not match the expected checksum.'
  }
  Move-Item "$pkg.part" $pkg -Force
}

$wanted = @{
  'lib/net462/Microsoft.Web.WebView2.Core.dll'     = 'Microsoft.Web.WebView2.Core.dll'
  'lib/net462/Microsoft.Web.WebView2.WinForms.dll' = 'Microsoft.Web.WebView2.WinForms.dll'
  "runtimes/win-$arch/native/WebView2Loader.dll"   = 'WebView2Loader.dll'
}
$zip = [IO.Compression.ZipFile]::OpenRead($pkg)
try {
  foreach ($e in $zip.Entries) {
    if ($wanted.ContainsKey($e.FullName)) {
      $dest = Join-Path $Bin $wanted[$e.FullName]
      try { [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $dest, $true) } catch { if (-not (Test-Path $dest)) { throw } }
    }
  }
} finally { $zip.Dispose() }

foreach ($dll in $wanted.Values) {
  $sig = Get-AuthenticodeSignature (Join-Path $Bin $dll)
  if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
    throw "$dll is not signed by Microsoft ($($sig.Status))."
  }
}

# ---- compile ----
$csc = @("$env:SystemRoot\Microsoft.NET\Framework64\v4.0.30319\csc.exe", "$env:SystemRoot\Microsoft.NET\Framework\v4.0.30319\csc.exe") |
  Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) { throw 'The .NET Framework 4 C# compiler (csc.exe) was not found.' }
$tmp = Join-Path $Bin 'StorageCleaner.new.exe'
$out = & $csc -nologo -optimize -target:winexe "-out:$tmp" "-win32icon:$Ico" `
  "-r:$(Join-Path $Bin 'Microsoft.Web.WebView2.Core.dll')" "-r:$(Join-Path $Bin 'Microsoft.Web.WebView2.WinForms.dll')" `
  -r:System.Windows.Forms.dll -r:System.Drawing.dll -r:System.Web.Extensions.dll $src 2>&1
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $tmp)) { throw "Could not build the app window:`n$($out -join "`n")" }
try { Move-Item $tmp $Exe -Force } catch { Remove-Item $tmp -Force; throw 'The app window is open; close it and try again.' }
Set-Content $StampFile $stamp
$Exe
