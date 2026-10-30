# Builds every app icon from resources/icon-source.png (square artwork, art to the edges, no corners):
#   resources/icon.png (256), resources/icon-1024.png (macOS; electron-builder makes the .icns),
#   resources/icon.ico, src/renderer/public/icon.png + icon@2x.png (title bar)
#   and src/renderer/public/logo.png + logo@2x.png + logo@3x.png (Settings → About).
# Every size is the artwork, resampled from the source.
# Run: pwsh -File scripts/make-icon.ps1
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'resources/icon-source.png'
# Windows uses these icon sizes across Explorer, taskbar and installer.
$icoSizes = 16, 24, 32, 48, 64, 128, 256
# macOS app icons need a 1024 px master (512 pt @2x).
$MAC_ICON_PX = 1024
# Corner radius as a share of the edge; matches the tray limit icons' rounded shape.
$CORNER_RATIO = 0.22
# Must match --titlebar-icon-size in src/renderer/src/styles/tokens.css.
$TITLEBAR_ICON_PX = 28
# Must match --about-logo-size in src/renderer/src/styles/tokens.css.
$ABOUT_LOGO_PX = 96
# Display scales the About logo stays sharp at: 100%, 200% (Retina) and 300% (high-DPI Windows).
$ABOUT_LOGO_SCALES = 1, 2, 3

function New-RoundedPath([int]$size) {
  $d = 2 * $size * $CORNER_RATIO
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, $d, $d, 180, 90)
  $path.AddArc($size - $d, 0, $d, $d, 270, 90)
  $path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
  $path.AddArc(0, $size - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-Canvas([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.SmoothingMode = 'AntiAlias'
  $g.PixelOffsetMode = 'HighQuality'
  return $bmp, $g
}

function New-ArtBitmap([System.Drawing.Image]$art, [int]$size) {
  $scaled, $sg = New-Canvas $size
  $sg.InterpolationMode = 'HighQualityBicubic'
  $sg.DrawImage($art, 0, 0, $size, $size)
  $sg.Dispose()
  # Filling the rounded path (not clipping to it) anti-aliases the corners; a clip leaves them jagged at small sizes.
  $bmp, $g = New-Canvas $size
  $g.FillPath((New-Object System.Drawing.TextureBrush $scaled), (New-RoundedPath $size))
  $g.Dispose()
  $scaled.Dispose()
  return $bmp
}

function Get-PngBytes([System.Drawing.Bitmap]$bmp) {
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  return , $ms.ToArray()
}

$art = [System.Drawing.Image]::FromFile($source)
try {
  $pngs = @{}
  foreach ($s in $icoSizes) { $pngs[$s] = Get-PngBytes (New-ArtBitmap $art $s) }
  [IO.File]::WriteAllBytes((Join-Path $root 'resources/icon.png'), $pngs[256])
  [IO.File]::WriteAllBytes((Join-Path $root 'resources/icon-1024.png'), (Get-PngBytes (New-ArtBitmap $art $MAC_ICON_PX)))
  # Title bar artwork; @2x serves 200% scaling.
  [IO.File]::WriteAllBytes((Join-Path $root 'src/renderer/public/icon.png'), (Get-PngBytes (New-ArtBitmap $art $TITLEBAR_ICON_PX)))
  [IO.File]::WriteAllBytes((Join-Path $root 'src/renderer/public/icon@2x.png'), (Get-PngBytes (New-ArtBitmap $art (2 * $TITLEBAR_ICON_PX))))
  foreach ($x in $ABOUT_LOGO_SCALES) {
    $name = if ($x -eq 1) { 'logo.png' } else { "logo@${x}x.png" }
    [IO.File]::WriteAllBytes((Join-Path $root "src/renderer/public/$name"), (Get-PngBytes (New-ArtBitmap $art ($x * $ABOUT_LOGO_PX))))
  }
} finally {
  $art.Dispose()
}

# ICO: 6-byte header, 16-byte directory entry per image, then PNG payloads.
$out = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $out
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$icoSizes.Count)
$offset = 6 + 16 * $icoSizes.Count
foreach ($s in $icoSizes) {
  $dim = if ($s -ge 256) { 0 } else { $s }  # 0 encodes 256 in the ICO format
  $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([uint16]1); $w.Write([uint16]32)
  $w.Write([uint32]$pngs[$s].Length); $w.Write([uint32]$offset)
  $offset += $pngs[$s].Length
}
foreach ($s in $icoSizes) { $w.Write($pngs[$s]) }
$w.Flush()
[IO.File]::WriteAllBytes((Join-Path $root 'resources/icon.ico'), $out.ToArray())
Write-Output "icons written"
