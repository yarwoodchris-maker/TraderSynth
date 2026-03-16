$MaskPath = Join-Path $PSScriptRoot "DataDesk_Bundle.dat"
$ZipPath = Join-Path $PSScriptRoot "DataDesk_Bundle.zip"
$AppDir = Join-Path $PSScriptRoot "DataDesk_App"

Write-Host "[*] Hydrating DataDesk v5..." -ForegroundColor Cyan

# Decode
$MaskData = Get-Content $MaskPath -Raw
$Bytes = [Convert]::FromBase64String($MaskData)
[IO.File]::WriteAllBytes($ZipPath, $Bytes)

# Extract
if (Test-Path $AppDir) { Remove-Item $AppDir -Recurse -Force }
New-Item -ItemType Directory -Path $AppDir | Out-Null
Expand-Archive -Path $ZipPath -DestinationPath $AppDir -Force

# Cleanup Zip
Remove-Item $ZipPath -Force

Write-Host "[SUCCESS] DataDesk v5 has been restored." -ForegroundColor Green
$ExePath = Join-Path $AppDir "DataDesk.Engine.exe"
Write-Host "[*] Launching: $ExePath" -ForegroundColor Yellow
& $ExePath
