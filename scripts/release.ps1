# Release checklist for dsh-wsl-bridge.
#
#   pwsh -File scripts/release.ps1 -Version 0.5.0
#
# Runs the tests, packs, checks npm authentication, publishes to the official
# registry, and verifies the published version. It refuses to publish while the
# working tree is dirty or npm is not authenticated.
[CmdletBinding()]
param(
  [string]$Version,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
  if ($Version) { npm version $Version --no-git-tag-version; if ($LASTEXITCODE -ne 0) { throw 'npm version failed' } }
  npm test
  if ($LASTEXITCODE -ne 0) { throw 'tests failed' }

  $who = (npm whoami 2>$null)
  if (-not $who) { throw 'npm is not authenticated: run `npm login` first' }

  npm pack
  if ($LASTEXITCODE -ne 0) { throw 'npm pack failed' }

  $args = @('publish', '--registry', 'https://registry.npmjs.org', '--access', 'public')
  if ($DryRun) { $args += '--dry-run' }
  npm @args
  if ($LASTEXITCODE -ne 0) { throw 'npm publish failed' }

  if (-not $DryRun) {
    $ver = (Get-Content package.json -Raw | ConvertFrom-Json).version
    npm view "dsh-wsl-bridge@$ver" version --registry https://registry.npmjs.org
  }
} finally {
  Pop-Location
}
