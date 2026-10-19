# Release checklist for dsh-wsl-bridge.
#
#   npm version 0.5.0 --no-git-tag-version
#   # Commit the version and release notes, then:
#   pwsh -File scripts/release.ps1
#
# Runs the tests, packs, checks npm authentication, publishes to the official
# registry, and verifies the published version. It refuses to publish while the
# working tree is dirty or npm is not authenticated.
[CmdletBinding()]
param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
  $registry = 'https://registry.npmjs.org'
  if (-not $DryRun) {
    $status = @(git status --porcelain)
    if ($LASTEXITCODE -ne 0) { throw 'git status failed' }
    if ($status.Count -gt 0) { throw 'working tree is dirty: commit the release changes first' }
  }
  npm test
  if ($LASTEXITCODE -ne 0) { throw 'tests failed' }

  if (-not $DryRun) {
    $who = npm whoami --registry $registry 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $who) {
      throw 'npm is not authenticated: run `npm login --registry https://registry.npmjs.org` first'
    }
  }

  $packedJson = npm pack --json
  if ($LASTEXITCODE -ne 0) { throw 'npm pack failed' }
  $packed = @($packedJson | ConvertFrom-Json)[0]

  $publishArgs = @('publish', $packed.filename, '--registry', $registry, '--access', 'public')
  if ($DryRun) { $publishArgs += '--dry-run' }
  npm @publishArgs
  if ($LASTEXITCODE -ne 0) { throw 'npm publish failed' }

  if (-not $DryRun) {
    $published = npm view "$($packed.name)@$($packed.version)" version --registry $registry
    if ($LASTEXITCODE -ne 0 -or "$published".Trim() -ne $packed.version) {
      throw 'published version verification failed'
    }
  }
} finally {
  Pop-Location
}
