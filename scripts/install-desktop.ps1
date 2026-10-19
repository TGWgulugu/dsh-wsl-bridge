# Install this bundle into the official DSH Desktop profile and explain the restart.
#
#   pwsh -File scripts/install-desktop.ps1
#   pwsh -File scripts/install-desktop.ps1 -Cli <path-to-dsh.cmd>
#
# The host half only loads on the next DSH Desktop start: quit the app from the
# tray, then open it again.
[CmdletBinding()]
param(
  [string]$Cli = '',
  [string]$Profile = 'desktop',
  [string]$PackageDir = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
if ($Cli -eq '') {
  $onPath = Get-Command dsh.cmd -ErrorAction SilentlyContinue
  if ($onPath) { $Cli = $onPath.Source }
}
if ($Cli -eq '' -or -not (Test-Path $Cli)) {
  throw 'DSH CLI not found. Pass -Cli <path to dsh.cmd>, or put dsh.cmd on PATH.'
}
if (-not (Test-Path (Join-Path $PackageDir 'package.json'))) { throw "not a package directory: $PackageDir" }

$env:DSH_HOME = $null
& $Cli plugin --profile $Profile add $PackageDir
if ($LASTEXITCODE -ne 0) { throw "dsh plugin add failed with exit code $LASTEXITCODE" }

Write-Host ''
Write-Host 'Installed. Now fully quit DSH Desktop from the tray and open it again.' -ForegroundColor Green
Write-Host 'After the restart:' -ForegroundColor Green
Write-Host '  - any session has wsl_bash / wsl_read / wsl_write / wsl_edit / wsl_path / wsl_env'
Write-Host '  - the new-session mode picker has a WSL entry (Linux paths, WSL bash)'
Write-Host ''
Write-Host 'Rollback:' -ForegroundColor Yellow
Write-Host "  $Cli plugin --profile $Profile remove dsh-wsl-bridge"
Write-Host "  then run 'pnpm install' in \$env:USERPROFILE\.dsh\profiles\$Profile if the app fails to start"
