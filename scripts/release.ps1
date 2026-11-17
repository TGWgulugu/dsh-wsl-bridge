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
    for ($attempt = 1; $attempt -le 30; $attempt += 1) {
      $published = npm view "$($packed.name)@$($packed.version)" version --registry $registry --prefer-online --fetch-retries 0 --fetch-timeout 15000 2>$null
      if ($LASTEXITCODE -eq 0 -and "$published".Trim() -eq $packed.version) { break }
      if ($attempt -eq 30) {
        throw 'published version verification failed after waiting for npm processing; the package upload already succeeded'
      }
      Write-Host "Waiting for npm to expose $($packed.name)@$($packed.version) ($attempt/30)"
      Start-Sleep -Seconds 10
    }
  }
} finally {
  Pop-Location
}
