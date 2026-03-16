<#
.SYNOPSIS
    DataDesk v5 Portable Packager (Multi-File Bundle)
    Bypasses enterprise .exe blocks by packaging the entire build into a masked archive.
#>

$BuildDir = Join-Path $PSScriptRoot "BuildOutput"
$PortableDir = Join-Path $PSScriptRoot "PortablePackage"
$TempZip = Join-Path $PSScriptRoot "DataDesk_Bundle.zip"

Write-Host "--- DataDesk v5 Portable Packager ---" -ForegroundColor Cyan

# 1. Ensure Build Exists
if (-not (Test-Path $BuildDir) -or -not (Get-ChildItem $BuildDir)) {
    Write-Error "Build not found. Run .\Build-Enterprise.ps1 first."
    exit 1
}

# 2. Setup Portable Folder
if (Test-Path $PortableDir) { Remove-Item $PortableDir -Recurse -Force }
New-Item -ItemType Directory -Path $PortableDir | Out-Null

# 3. Zip all build files
Write-Host "[*] Bundling all build dependencies..." -ForegroundColor Green
if (Test-Path $TempZip) { Remove-Item $TempZip -Force }
Compress-Archive -Path "$BuildDir\*" -DestinationPath $TempZip -Force

# 4. Mash binary into a portable text blob
Write-Host "[*] Masking archive as portable text blob..." -ForegroundColor Green
$Bytes = [System.IO.File]::ReadAllBytes($TempZip)
$Base64 = [System.Convert]::ToBase64String($Bytes)
$Base64 | Out-File (Join-Path $PortableDir "DataDesk_Bundle.dat") -Encoding ascii

# 5. Cleanup temp zip
Remove-Item $TempZip -Force

# 6. Create the 'Resilient' Bootstrap
$Bootstrap = @"
`$MaskPath = Join-Path `$PSScriptRoot "DataDesk_Bundle.dat"
`$ZipPath = Join-Path `$PSScriptRoot "DataDesk_Bundle.zip"
`$AppDir = Join-Path `$PSScriptRoot "DataDesk_App"

Write-Host "[*] Hydrating DataDesk v5..." -ForegroundColor Cyan

# Decode
`$MaskData = Get-Content `$MaskPath -Raw
`$Bytes = [Convert]::FromBase64String(`$MaskData)
[IO.File]::WriteAllBytes(`$ZipPath, `$Bytes)

# Extract
if (Test-Path `$AppDir) { Remove-Item `$AppDir -Recurse -Force }
New-Item -ItemType Directory -Path `$AppDir | Out-Null
Expand-Archive -Path `$ZipPath -DestinationPath `$AppDir -Force

# Cleanup Zip
Remove-Item `$ZipPath -Force

Write-Host "[SUCCESS] DataDesk v5 has been restored." -ForegroundColor Green
`$ExePath = Join-Path `$AppDir "DataDesk.Engine.exe"
Write-Host "[*] Launching: `$ExePath" -ForegroundColor Yellow
& `$ExePath
"@
$Bootstrap | Out-File (Join-Path $PortableDir "Restore-DataDesk.ps1")

Write-Host "`n[COMPLETED] Portable bundle created in .\PortablePackage" -ForegroundColor Cyan
Write-Host "Files to share:" -ForegroundColor Magenta
Write-Host "1. DataDesk_Bundle.dat  (The masked archive)"
Write-Host "2. Restore-DataDesk.ps1 (The restoration script)"
