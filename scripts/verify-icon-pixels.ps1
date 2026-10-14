$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
if (-not ('TrackerIconProbe' -as [type])) { Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class TrackerIconProbe {
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr LoadImage(IntPtr instance, string file, uint type, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr icon);
}
'@ }
$project = Split-Path $PSScriptRoot -Parent
$fixture = Join-Path $project 'artifacts\native-icons'
New-Item -ItemType Directory -Path $fixture -Force | Out-Null
Push-Location $project
try {
  Remove-Item (Join-Path $project 'artifacts\native-icon-verification.json') -ErrorAction SilentlyContinue
  node (Join-Path $project 'scripts\generate-native-icon-fixtures.cjs')
  if ($LASTEXITCODE -ne 0) { throw 'Icon generation failed' }
  $results = @()
  foreach ($value in @(0,7,87,100)) {
    foreach ($size in @(16,20,24,28,32,36,40,44,48,56,64)) {
      $iconFile = Join-Path $fixture "$value.ico"
      $handle = [TrackerIconProbe]::LoadImage([IntPtr]::Zero,$iconFile,1,$size,$size,0x10)
      if ($handle -eq [IntPtr]::Zero) { throw "LoadImage failed for $value at $size" }
      $icon = [Drawing.Icon]::FromHandle($handle)
      $bitmap = $icon.ToBitmap()
      $expected = [Drawing.Bitmap]::new((Join-Path $fixture "$value-$size.png"))
      try {
        if ($bitmap.Width -ne $size -or $bitmap.Height -ne $size) { throw 'Wrong native icon dimensions' }
        $difference = 0
        for ($y=0; $y -lt $size; $y++) { for ($x=0; $x -lt $size; $x++) {
          $a=$bitmap.GetPixel($x,$y); $b=$expected.GetPixel($x,$y)
          # Native HICON premultiplication can round RGB by one. Alpha must stay exact.
          if ($a.A -ne $b.A) { $difference++ }
          elseif ($a.A -eq 255 -and ($a.R -ne $b.R -or $a.G -ne $b.G -or $a.B -ne $b.B)) { $difference++ }
        }}
        $bitmap.Save((Join-Path $fixture "native-$value-$size.png"),[Drawing.Imaging.ImageFormat]::Png)
        $results += [pscustomobject]@{value=$value; pixels=$size; differentPixels=$difference}
        if ($difference -ne 0) { throw "Unexpected resampling for $value at $size ($difference pixels)" }
      } finally { $expected.Dispose(); $bitmap.Dispose(); $icon.Dispose(); [TrackerIconProbe]::DestroyIcon($handle) | Out-Null }
    }
  }
  $results | ConvertTo-Json | Set-Content (Join-Path $project 'artifacts\native-icon-verification.json') -Encoding utf8
  "Verified $($results.Count) Windows HICONs at exact pixel sizes, including 225% (36px)."
} finally { Pop-Location }
