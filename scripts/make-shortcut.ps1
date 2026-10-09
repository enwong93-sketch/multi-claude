# Creates an icon for a runtime and a .lnk that starts it without any console window.
# The icon is the installed Claude app's own icon (read from its exe at run time, nothing is bundled or redistributed) with a
# round coloured badge carrying the runtime's letter in the lower right corner, so the runtimes are easy to tell apart.
param(
  [Parameter(Mandatory)][string]$Letter,
  [Parameter(Mandatory)][string]$Color,        # badge colour, #rrggbb
  [Parameter(Mandatory)][string]$Title,
  [Parameter(Mandatory)][string]$Vbs,          # launcher script to run through wscript
  [Parameter(Mandatory)][string]$IconPath,
  [Parameter(Mandatory)][string[]]$OutDirs,
  [string]$BaseExe                              # Claude.exe to take the base icon from
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class McIcons {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern uint PrivateExtractIcons(string file, int index, int cx, int cy, IntPtr[] icons, uint[] ids, uint n, uint flags);
  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr h);
}
'@

function Get-BaseBitmap([string]$exe) {
  if ($exe -and (Test-Path -LiteralPath $exe)) {
    $h = New-Object IntPtr[] 1; $ids = New-Object uint32[] 1
    $n = [McIcons]::PrivateExtractIcons($exe, 0, 256, 256, $h, $ids, 1, 0)
    if ($n -ge 1 -and $h[0] -ne [IntPtr]::Zero) {
      $ico = [Drawing.Icon]::FromHandle($h[0]); $bmp = New-Object Drawing.Bitmap 256, 256
      $gg = [Drawing.Graphics]::FromImage($bmp); $gg.InterpolationMode = 'HighQualityBicubic'; $gg.DrawIcon($ico, (New-Object Drawing.Rectangle 0, 0, 256, 256)); $gg.Dispose()
      [void][McIcons]::DestroyIcon($h[0]); return $bmp
    }
  }
  return $null
}

$bmp = New-Object Drawing.Bitmap 256, 256
$g = [Drawing.Graphics]::FromImage($bmp); $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAlias'; $g.InterpolationMode = 'HighQualityBicubic'
$g.Clear([Drawing.Color]::Transparent)
$base = Get-BaseBitmap $BaseExe
if ($base) { $g.DrawImage($base, 0, 0, 256, 256) }
else { $g.FillEllipse((New-Object Drawing.SolidBrush ([Drawing.ColorTranslator]::FromHtml($Color))), 8, 8, 240, 240) }   # fallback: plain disc

$cx = 200; $cy = 200
$g.FillEllipse([Drawing.Brushes]::White, $cx - 61, $cy - 61, 122, 122)
$g.FillEllipse((New-Object Drawing.SolidBrush ([Drawing.ColorTranslator]::FromHtml($Color))), $cx - 52, $cy - 52, 104, 104)
$f = New-Object Drawing.Font 'Segoe UI', 64, ([Drawing.FontStyle]::Bold), ([Drawing.GraphicsUnit]::Pixel)
$sf = New-Object Drawing.StringFormat; $sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
$g.DrawString($Letter.Substring(0, 1).ToUpper(), $f, [Drawing.Brushes]::White, (New-Object Drawing.RectangleF ($cx - 52), ($cy - 52), 104, 104), $sf)

$ms = New-Object IO.MemoryStream; $bmp.Save($ms, [Drawing.Imaging.ImageFormat]::Png); $png = $ms.ToArray()
[void][IO.Directory]::CreateDirectory((Split-Path $IconPath))
$fs = [IO.File]::Create($IconPath); $bw = New-Object IO.BinaryWriter $fs
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]1)                 # ICONDIR: one image
$bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([byte]0)   # 256x256, no palette
$bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]$png.Length); $bw.Write([uint32]22); $bw.Write($png)
$bw.Close()

$sh = New-Object -ComObject WScript.Shell
foreach ($dir in $OutDirs) {
  [void][IO.Directory]::CreateDirectory($dir)
  $l = $sh.CreateShortcut((Join-Path $dir "$Title.lnk"))
  $l.TargetPath = "$env:SystemRoot\System32\wscript.exe"
  $l.Arguments = "//B //Nologo `"$Vbs`""
  $l.IconLocation = "$IconPath,0"
  $l.Description = $Title
  $l.Save()
  Write-Output (Join-Path $dir "$Title.lnk")
}
