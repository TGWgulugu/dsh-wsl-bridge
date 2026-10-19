$ErrorActionPreference = 'Stop'
$release = Join-Path $PSScriptRoot '../scripts/release.ps1'

function git {
  $global:LASTEXITCODE = 0
  if ($global:bridgeReleaseScenario -eq 'dirty') { ' M package.json' }
}
function npm {
  $global:bridgeReleaseCalls.Add(($args -join ' '))
  $global:LASTEXITCODE = 0
  switch ($args[0]) {
    'whoami' {
      if ($global:bridgeReleaseScenario -eq 'auth') { $global:LASTEXITCODE = 1; 'an error is not a user' }
      else { 'release-test-user' }
    }
    'pack' {
      if ($global:bridgeReleaseScenario -eq 'pack') { $global:LASTEXITCODE = 1 }
      else { '[{"name":"dsh-wsl-bridge","version":"0.4.5","filename":"dsh-wsl-bridge-0.4.5.tgz"}]' }
    }
    'view' {
      if ($global:bridgeReleaseScenario -eq 'verify') { $global:LASTEXITCODE = 1 }
      else { '0.4.5' }
    }
  }
}

foreach ($scenario in @('dry', 'dirty', 'auth', 'pack', 'verify', 'success')) {
  $global:bridgeReleaseScenario = $scenario
  $global:bridgeReleaseCalls = [System.Collections.Generic.List[string]]::new()
  $failure = $null
  try { & $release -DryRun:($scenario -eq 'dry') } catch { $failure = $_.Exception.Message }
  $expected = switch ($scenario) {
    'dirty' { 'working tree is dirty' }
    'auth' { 'npm is not authenticated' }
    'pack' { 'npm pack failed' }
    'verify' { 'published version verification failed' }
  }
  if ($expected) {
    if (-not $failure -or -not $failure.Contains($expected)) { throw "$scenario unexpected failure: $failure" }
  } elseif ($failure) { throw "$scenario failed: $failure" }
  if ($scenario -eq 'dry' -and ($global:bridgeReleaseCalls -match '^whoami')) { throw 'dry-run requires authentication' }
  if ($scenario -in @('dirty', 'auth', 'pack') -and ($global:bridgeReleaseCalls -match '^publish')) { throw 'published after failed preflight' }
  if ($scenario -in @('dry', 'verify', 'success')) {
    if (-not ($global:bridgeReleaseCalls -match '^publish dsh-wsl-bridge-0.4.5.tgz --registry https://registry.npmjs.org')) { throw 'must publish tested tarball to official registry' }
  }
  if ($scenario -eq 'success' -and -not ($global:bridgeReleaseCalls -match '^whoami --registry https://registry.npmjs.org')) { throw 'authentication registry mismatch' }
  Write-Host "ok   release: $scenario"
}
Write-Host '6 release script checks passed'
