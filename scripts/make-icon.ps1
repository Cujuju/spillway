# Draws the app icon (navy tile, three quota bars) and writes resources/icon.png,
# resources/icon.ico (PNG-compressed entries), resources/icon-1024.png (macOS; electron-builder
# makes the .icns from it) and src/renderer/public/icon.png.
# Run: pwsh -File scripts/make-icon.ps1
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
# Windows uses these icon sizes across Explorer, taskbar and installer.
$sizes = 16, 24, 32, 48, 64, 128, 256

function New-IconBitmap([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $r = [Math]::Max(2, [int]($size * 0.22))
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, $r * 2, $r * 2, 180, 90)
  $path.AddArc($size - $r * 2 - 1, 0, $r * 2, $r * 2, 270, 90)
  $path.AddArc($size - $r * 2 - 1, $size - $r * 2 - 1, $r * 2, $r * 2, 0, 90)
  $path.AddArc(0, $size - $r * 2 - 1, $r * 2, $r * 2, 90, 90)
  $path.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#16213e'))), $path)
  # Three bars at descending fill: indigo accent, Claude orange, green.
  $colors = '#6366f1', '#d97757', '#10b981'
  $heights = 0.62, 0.44, 0.28
  $barW = $size * 0.16
  $gap = $size * 0.08
  $left = ($size - (3 * $barW + 2 * $gap)) / 2
  $bottom = $size * 0.8
  for ($i = 0; $i -lt 3; $i++) {
    $h = $size * $heights[$i]
    $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($colors[$i]))
    $g.FillRectangle($brush, [single]($left + $i * ($barW + $gap)), [single]($bottom - $h), [single]$barW, [single]$h)
  }
  $g.Dispose()
  return $bmp
}

function Get-PngBytes([System.Drawing.Bitmap]$bmp) {
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  return , $ms.ToArray()
}

$pngs = @{}
foreach ($s in $sizes) { $pngs[$s] = Get-PngBytes (New-IconBitmap $s) }
[IO.File]::WriteAllBytes((Join-Path $root 'resources/icon.png'), $pngs[256])
# macOS app icons need a 1024px master (512pt @2x).
$MAC_ICON_PX = 1024
[IO.File]::WriteAllBytes((Join-Path $root 'resources/icon-1024.png'), (Get-PngBytes (New-IconBitmap $MAC_ICON_PX)))
[IO.File]::WriteAllBytes((Join-Path $root 'src/renderer/public/icon.png'), $pngs[32])

# ICO: 6-byte header, 16-byte directory entry per image, then PNG payloads.
$out = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $out
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
foreach ($s in $sizes) {
  $dim = if ($s -ge 256) { 0 } else { $s }  # 0 encodes 256 in the ICO format
  $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([uint16]1); $w.Write([uint16]32)
  $w.Write([uint32]$pngs[$s].Length); $w.Write([uint32]$offset)
  $offset += $pngs[$s].Length
}
foreach ($s in $sizes) { $w.Write($pngs[$s]) }
$w.Flush()
[IO.File]::WriteAllBytes((Join-Path $root 'resources/icon.ico'), $out.ToArray())
Write-Output "icons written"
