<#
  Omnibus deploy - check, build, start, verify, and roll back automatically if
  the new version doesn't come up healthy.

  Run from the Omnibus folder (the one with docker-compose.yml):
    .\deploy.ps1              build and deploy the code in this folder
    .\deploy.ps1 -Rollback    switch back to the version that ran before the last deploy

  The running app keeps serving while the new image builds. If the build fails,
  nothing changes. If the new version starts but doesn't answer its health
  check, the previous version is put back.
#>
param(
  [switch]$Rollback,
  [switch]$AllowLegacyRestart,
  [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = 'Continue'
Set-Location -Path $PSScriptRoot

$Compose   = 'docker-compose.yml'
$Image     = 'omnibus-omnibus'
$Container = 'omnibus'
$Port      = 9810

function Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Good($m) { Write-Host "OK  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "!!  $m" -ForegroundColor Yellow }
function Bad($m)  { Write-Host "XX  $m" -ForegroundColor Red }

# Wait until $Url answers with HTTP 200 (or, with -AnyResponse, any HTTP reply).
function Wait-Healthy([string]$Url, [switch]$AnyResponse) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
      if ($r.StatusCode -eq 200) { return $true }
    } catch {
      if ($AnyResponse -and $_.Exception.Response) { return $true }
    }
    Start-Sleep -Seconds 3
  }
  return $false
}

# Ask the current container to stop admitting mutations and finish owned work.
# A timeout aborts replacement; it is never permission to kill the writer.
function Resume-Writes {
  docker exec $Container test -f /app/backend/deployControl.js 2>$null
  if ($LASTEXITCODE -ne 0) { return }
  docker exec $Container node backend/deployControl.js resume 2>$null | Out-Null
}
function Drain-Writes {
  $running = docker inspect -f '{{.State.Running}}' $Container 2>$null
  if ($LASTEXITCODE -ne 0 -or $running -ne 'true') { return $true }
  docker exec $Container test -f /app/backend/deployControl.js 2>$null
  if ($LASTEXITCODE -ne 0) {
    if ($AllowLegacyRestart) { Warn "Legacy restart: the running version cannot drain work. Existing recovery holds are preserved."; return $true }
    Bad "This running version predates safe deployment draining. For the first upgrade only, use -AllowLegacyRestart when no metadata operation is actively running (an existing recovery hold already pauses writes)."
    return $false
  }
  Step "Pausing new metadata work and waiting for active writes (up to 120 seconds)"
  docker exec $Container node backend/deployControl.js drain | Out-Host
  if ($LASTEXITCODE -eq 0) { Good "Library writes drained"; return $true }
  Bad "Drain failed or timed out. The running container will NOT be replaced."
  Resume-Writes
  return $false
}

function Restore-Previous {
  docker image inspect "${Image}:previous" > $null 2>&1
  if ($LASTEXITCODE -ne 0) { Bad "No previous image saved - nothing to roll back to."; return $false }
  if (-not (Drain-Writes)) { return $false }
  docker tag "${Image}:previous" "${Image}:latest"
  if ($LASTEXITCODE -ne 0) { Resume-Writes; return $false }
  docker compose -f $Compose up -d --no-build --force-recreate
  if ($LASTEXITCODE -ne 0) { Resume-Writes; return $false }
  # The previous build may predate /api/health, so accept any reply from the web root.
  if (Wait-Healthy "http://localhost:$Port/" -AnyResponse) { Good "Previous version is running again."; return $true }
  Bad "Previous version did not come up either. Check: docker logs $Container --tail 50"
  return $false
}

if ($Rollback) {
  Step "Rolling back to the previous image"
  if (Restore-Previous) { exit 0 } else { exit 1 }
}

# 1. Uncommitted changes are deployed too - just make that visible.
$dirty = git status --porcelain 2>$null
if ($dirty) { Warn "Deploying uncommitted changes (they are not in GitHub yet)." }

# 2. Catch server syntax errors before touching anything.
Step "Checking backend/server.js"
docker run --rm -v "${PSScriptRoot}\backend:/b" node:22-alpine node --check /b/server.js
if ($LASTEXITCODE -ne 0) { Bad "server.js has a syntax error - nothing was changed."; exit 1 }
Good "server.js syntax OK"

# 2b. API keys in the database are encrypted with OMNIBUS_SECRET (backend/secrets.js).
#     Add one to .env the first time; the same secret is needed to read keys from a restored backup.
$EnvFile = Join-Path $PSScriptRoot '.env'
if ((Test-Path $EnvFile) -and -not (Select-String -Path $EnvFile -Pattern '^\s*OMNIBUS_SECRET\s*=\s*\S' -Quiet)) {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $secret = -join ($bytes | ForEach-Object { $_.ToString('x2') })
  Add-Content -Path $EnvFile -Value "`r`n# Encrypts the API keys stored in the database (added by deploy.ps1).`r`n# Keep a copy of this .env somewhere safe: a restored backup needs the same secret to read its keys.`r`nOMNIBUS_SECRET=$secret"
  Warn "Added OMNIBUS_SECRET to .env. Save a copy of .env somewhere safe (a password manager)."
}

# 3. Save the running image as the rollback point.
$current = docker inspect -f '{{.Image}}' $Container 2>$null
if ($LASTEXITCODE -eq 0 -and $current) {
  docker tag $current "${Image}:previous"
  Good "Saved the running version as ${Image}:previous"
} else {
  Warn "No running container found - there will be no rollback point."
}

# 4. Build while the current version keeps running.
Step "Building (the app stays up meanwhile)"
docker compose -f $Compose build
if ($LASTEXITCODE -ne 0) { Bad "Build failed - the running version was left untouched."; exit 1 }

# 5. Drain the running version before replacement.
if (-not (Drain-Writes)) { exit 1 }

# Start the new version.
Step "Starting the new version"
docker compose -f $Compose up -d
if ($LASTEXITCODE -ne 0) {
  Resume-Writes
  Bad "Start failed - rolling back."
  Restore-Previous | Out-Null
  exit 1
}

# Compose may keep the same container when its image has not changed.
Resume-Writes

# 6. Confirm it actually works.
Step "Waiting for http://localhost:$Port/api/health"
if (Wait-Healthy "http://localhost:$Port/api/health") {
  Good "Deployed. To undo: .\deploy.ps1 -Rollback"
  # The code works; also confirm the comics folder is visible. A missing
  # folder is a drive-sharing problem, not a code problem, so no rollback.
  try {
    $h = Invoke-RestMethod -Uri "http://localhost:$Port/api/health" -TimeoutSec 10
    if ($h.comics -eq $false) {
      Warn "The comics folder (/comics) is missing or empty inside the container."
      Warn "Check that the drive is shared with Docker Desktop and COMICS_HOST_PATH in .env is right, then: docker compose up -d --force-recreate"
    } else { Good "Comics folder is visible." }
  } catch { }
  exit 0
}

Bad "The new version did not become healthy within $TimeoutSeconds seconds. Last log lines:"
docker logs $Container --tail 30
Step "Rolling back"
if (Restore-Previous) { exit 1 } else { exit 2 }
