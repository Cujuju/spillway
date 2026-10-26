# Builds every app icon from resources/icon-source.png (square artwork, art to the edges, no corners):
#   resources/icon.png (256), resources/icon-1024.png (macOS; electron-builder makes the .icns),
#   resources/icon.ico and src/renderer/public/icon.png (title bar).
# 16-32 px sizes are a hand-drawn version of the same scene: the artwork blurs to a blob there,
# and those are the sizes the Windows tray, taskbar and title bar show.
# Run: pwsh -File scripts/make-icon.ps1
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'resources/icon-source.png'
# Windows uses these icon sizes across Explorer, taskbar and installer.
$icoSizes = 16, 24, 32, 48, 64, 128, 256
# At or below this size the hand-drawn version replaces the artwork.
$DRAWN_MAX_PX = 32
# macOS app icons need a 1024 px master (512 pt @2x).
$MAC_ICON_PX = 1024
# Corner radius as a share of the edge; matches the tray limit icons' rounded shape.
$CORNER_RATIO = 0.22

# Hand-drawn scene on a 32-unit grid; even coordinates land on whole pixels at 16 px.
$GRID = 32
$colors = @{ bg = '#021551'; stepTop = '#b7c8db'; stepFace = '#45618d'; water = '#05d8fa'; pool = '#0a7fd6' }
# x, y, width; each step is a 2-unit top over a 4-unit face.
$steps = @(@(4, 4, 14), @(8, 12, 20), @(4, 20, 16))
$STEP_TOP = 2
$STEP_FACE = 4
# x, y, width, height. Water crosses step 1, falls onto step 2, runs left, falls onto step 3, runs right, falls into the pool.
$water = @(@(10, 4, 8, 2), @(14, 4, 4, 10), @(8, 12, 10, 2), @(8, 12, 4, 10), @(8, 20, 12, 2), @(16, 20, 4, 8))
# x, y, width, height of the pool ellipse; it runs past the bottom edge.
$pool = @(0, 25, 32, 12)

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

function Brush([string]$hex) { New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($hex)) }

function New-ArtBitmap([System.Drawing.Image]$art, [int]$size) {
  $bmp, $g = New-Canvas $size
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.SetClip((New-RoundedPath $size))
  $g.DrawImage($art, 0, 0, $size, $size)
  $g.Dispose()
  return $bmp
}

function New-DrawnBitmap([int]$size) {
  $s = $size / $GRID
  $rect = { param($x, $y, $w, $h) [System.Drawing.RectangleF]::new($x * $s, $y * $s, $w * $s, $h * $s) }
  $bmp, $g = New-Canvas $size
  $outline = New-RoundedPath $size
  $g.FillPath((Brush $colors.bg), $outline)
  $g.SetClip($outline)
  # Hard pixel edges: anti-aliasing smears 1 px shapes at 16 px.
  $g.SmoothingMode = 'None'
  $g.FillEllipse((Brush $colors.pool), (& $rect @pool))
  foreach ($st in $steps) {
    $g.FillRectangle((Brush $colors.stepTop), (& $rect $st[0] $st[1] $st[2] $STEP_TOP))
    $g.FillRectangle((Brush $colors.stepFace), (& $rect $st[0] ($st[1] + $STEP_TOP) $st[2] $STEP_FACE))
  }
  foreach ($w in $water) { $g.FillRectangle((Brush $colors.water), (& $rect @w)) }
  $g.Dispose()
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
  foreach ($s in $icoSizes) { $pngs[$s] = Get-PngBytes ($(if ($s -le $DRAWN_MAX_PX) { New-DrawnBitmap $s } else { New-ArtBitmap $art $s })) }
  [IO.File]::WriteAllBytes((Join-Path $root 'resources/icon.png'), $pngs[256])
  [IO.File]::WriteAllBytes((Join-Path $root 'resources/icon-1024.png'), (Get-PngBytes (New-ArtBitmap $art $MAC_ICON_PX)))
  # Shown at 16 px in the title bar; 32 px covers 200% scaling.
  [IO.File]::WriteAllBytes((Join-Path $root 'src/renderer/public/icon.png'), $pngs[32])
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
