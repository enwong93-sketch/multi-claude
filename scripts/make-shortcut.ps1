# Creates a round coloured icon with a letter, and a .lnk that starts a runtime without any console window.
param(
  [Parameter(Mandatory)][string]$Letter,
  [Parameter(Mandatory)][string]$Color,        # #rrggbb
  [Parameter(Mandatory)][string]$Title,
  [Parameter(Mandatory)][string]$Vbs,          # launcher script to run through wscript
  [Parameter(Mandatory)][string]$IconPath,
  [Parameter(Mandatory)][string[]]$OutDirs
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$bmp = New-Object Drawing.Bitmap 256, 256
$g = [Drawing.Graphics]::FromImage($bmp); $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAlias'
$g.Clear([Drawing.Color]::Transparent)
$g.FillEllipse((New-Object Drawing.SolidBrush ([Drawing.ColorTranslator]::FromHtml($Color))), 8, 8, 240, 240)
$f = New-Object Drawing.Font 'Segoe UI', 130, ([Drawing.FontStyle]::Bold), ([Drawing.GraphicsUnit]::Pixel)
$sf = New-Object Drawing.StringFormat; $sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
$g.DrawString($Letter.Substring(0, 1).ToUpper(), $f, [Drawing.Brushes]::White, (New-Object Drawing.RectangleF 0, 0, 256, 256), $sf)
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
