<#
.SYNOPSIS
    DataDesk v5 Enterprise Build & Bootstrap Script (High-Reliability Version)
    Optimized for 100% offline environments.
#>

$ProjectDir = Join-Path $PSScriptRoot "DataDesk.Engine"
$OutputDir = Join-Path $PSScriptRoot "BuildOutput"

Write-Host "--- DataDesk v5 Enterprise Bootstrap ---" -ForegroundColor Cyan

# 1. Environment Check
$dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
if (-not $dotnet) {
    Write-Error "Microsoft .NET SDK not found."
    exit 1
}

# 2. Cleanup
if (Test-Path $OutputDir) { Remove-Item $OutputDir -Recurse -Force }
New-Item -ItemType Directory -Path $OutputDir | Out-Null

# Copy UI Assets
Write-Host "[*] Bundling UI Assets..." -ForegroundColor Gray
$UiDir = Join-Path $PSScriptRoot "www"
if (Test-Path $UiDir) {
    xcopy "$UiDir\*" "$OutputDir\" /E /I /Y | Out-Null
}

Set-Location $ProjectDir

# 3. Primary Build: Offline-Ready (Framework Dependent)
# We avoid --self-contained and win-x64 targeting by default, as these require
# downloading Runtime Packs from NuGet.
Write-Host "[*] Commencing Offline-Compatible Build..." -ForegroundColor Green

# Standard build uses what is already installed in your .NET SDK (Zero Network)
dotnet publish -c Release -o $OutputDir --no-self-contained

if ($LASTEXITCODE -eq 0) {
    Write-Host "`n[SUCCESS] DataDesk Engine v5 is born!" -ForegroundColor Green
    Write-Host "Mode: Framework Dependent (Requires .NET 10 on target)" -ForegroundColor Gray
    Write-Host "Binary Location: $(Join-Path $OutputDir "DataDesk.Engine.exe")" -ForegroundColor Yellow
}
else {
    Write-Host "`n[!] Build Error detected. Common Cause: Enterprise NuGet Block." -ForegroundColor Red
    Write-Host "If you see 'NU1100' errors, it means the SDK is trying to reach NuGet.org." -ForegroundColor Yellow
    Write-Host "`nACTION REQUIRED:" -ForegroundColor Magenta
    Write-Host "Please use the 'Package-Portable.ps1' strategy on a machine WITH internet,"
    Write-Host "then transfer the .dat file back to this restricted environment."
}
