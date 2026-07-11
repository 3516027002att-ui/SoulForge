[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'SoulForge\dotnet')
)

$ErrorActionPreference = 'Stop'
$installer = Join-Path $env:TEMP 'soulforge-dotnet-install.ps1'
Invoke-WebRequest -UseBasicParsing 'https://dot.net/v1/dotnet-install.ps1' -OutFile $installer

& powershell -NoProfile -ExecutionPolicy Bypass -File $installer `
  -Channel 10.0 `
  -Quality GA `
  -Architecture x64 `
  -InstallDir $InstallDir `
  -NoPath

if ($LASTEXITCODE -ne 0) {
  throw ".NET 10 SDK installation failed with exit code $LASTEXITCODE."
}

$dotnet = Join-Path $InstallDir 'dotnet.exe'
& $dotnet --version
Write-Host "SoulForge will auto-detect this SDK at $dotnet"
