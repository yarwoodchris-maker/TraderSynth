<#
.SYNOPSIS
    DataDesk v5 Enterprise Build & Bootstrap Script
    This script automates the on-site compilation of the C# engine to bypass binary transport blocks.
#>

$ProjectDir = Join-Path $PSScriptRoot "DataDesk.Engine"
$OutputDir = Join-Path $PSScriptRoot "BuildOutput"

Write-Host "--- DataDesk v5 Enterprise Bootstrap ---" -ForegroundColor Cyan

# 1. Environment Check
Write-Host "[*] Checking for .NET SDK..."
$dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
if (-not $dotnet) {
    Write-Error "Microsoft .NET 8.0 SDK not found. Please install from: https://dotnet.microsoft.com/download"
    exit 1
}

# 2. Cleanup
if (Test-Path $OutputDir) { Remove-Item $OutputDir -Recurse -Force }
New-Item -ItemType Directory -Path $OutputDir | Out-Null

# 3. Enterprise-Grade Build (Single-File, Self-Contained)
Write-Host "[*] Commencing On-Site Compilation..." -ForegroundColor Green
Set-Location $ProjectDir

# Publish flags: 
# - SelfContained: Includes .NET runtime in the .exe so no framework install is needed on target.
# - SingleFile: Packs everything into one binary for easy transfer.
# - RuntimeIdentifier: Fixed to win-x64 for Trader Desktop stability.
dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o $OutputDir

if ($LASTEXITCODE -eq 0) {
    Write-Host "`n[SUCCESS] DataDesk Engine v5 is born!" -ForegroundColor Green
    Write-Host "Binary Location: $(Join-Path $OutputDir "DataDesk.Engine.exe")" -ForegroundColor Yellow
    Write-Host "You can now sign this binary with your corporate certificate and deploy." -ForegroundColor Gray
}
else {
    Write-Error "Compilation Failed. Review logs above."
}
