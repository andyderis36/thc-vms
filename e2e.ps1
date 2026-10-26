<#
.SYNOPSIS
  One-click runner for the THC-VMS Playwright E2E suite.

.DESCRIPTION
  Usage:
      e2e.cmd                # LOCAL headed (default): pastikan stack hidup, lalu jalankan suite
      e2e.cmd live           # PRODUCTION headed (menulis data nyata; wajib ketik LIVE)
      e2e.cmd check          # cek stack lokal saja, tidak menjalankan test
      e2e.cmd live-check     # cek production via GET /health saja, tidak menulis data
      e2e-live.cmd           # shortcut double-click untuk mode live

  Local mode memakai backend :8080 + frontend :3210 yang sudah berjalan. Bila
  salah satu mati, script menyalakannya lewat vms.ps1 (docker -> be -> fe).
  Live mode TIDAK menyalakan stack lokal; ia menembak https://vms.thckalbar.com.

  Playwright yang dipakai adalah paket lokal di frontend/node_modules (bukan MCP).
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)][string]$Mode = 'local',
    [int]$SlowMo = 250
)

$ErrorActionPreference = 'Stop'
$RepoRoot = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$Frontend = Join-Path $RepoRoot 'frontend'
$Vms = Join-Path $RepoRoot 'vms.ps1'
$LiveUrl = 'https://vms.thckalbar.com'
$LivePacingMs = if ($env:E2E_LIVE_PACING_MS) { $env:E2E_LIVE_PACING_MS } else { '13000' }

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "    OK   $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "    WARN $msg" -ForegroundColor Yellow }
function Write-Err2($msg) { Write-Host "    FAIL $msg" -ForegroundColor Red }

function Test-Http([string]$Url) {
    try {
        $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
        return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 400)
    } catch {
        return $false
    }
}

function Wait-Http([string]$Url, [int]$Seconds = 90) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Http $Url) { return $true }
        Start-Sleep -Milliseconds 700
    }
    return $false
}

# Jangan pernah mewarisi target dari shell sebelumnya: tanpa ini, `e2e.cmd`
# setelah `e2e.cmd live` di terminal yang sama bisa menembak production.
function Clear-E2EOverrides {
    foreach ($name in @(
            'E2E_BASE_URL',
            'E2E_API_BASE_URL',
            'E2E_FRONTEND_BASE_URL',
            'E2E_LOGIN_PACING_MS',
            'E2E_SKIP_STORAGE_CLEANUP'
        )) {
        Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
    }
}

function Set-LocalE2EEnv {
    Clear-E2EOverrides
    $env:E2E_BASE_URL = 'http://localhost:3210'
    $env:E2E_API_BASE_URL = 'http://localhost:8080/api/v1'
    $env:E2E_FRONTEND_BASE_URL = 'http://localhost:3210'
    $env:E2E_SLOWMO = "$SlowMo"
}

function Set-LiveE2EEnv {
    Clear-E2EOverrides
    $env:E2E_BASE_URL = $LiveUrl
    $env:E2E_API_BASE_URL = "$LiveUrl/api/v1"
    $env:E2E_FRONTEND_BASE_URL = $LiveUrl
    $env:E2E_LOGIN_PACING_MS = $LivePacingMs
    $env:E2E_SKIP_STORAGE_CLEANUP = '1'
    $env:E2E_SLOWMO = "$SlowMo"
}

function Assert-LiveTarget {
    Write-Step "preflight production: GET $LiveUrl/api/v1/health"
    if (-not (Wait-Http "$LiveUrl/api/v1/health" 20)) {
        throw "production tidak sehat di $LiveUrl/api/v1/health. Periksa deploy sebelum menembak live."
    }
    Write-Ok "production sehat: $LiveUrl"
}

function Ensure-Dependencies {
    if (-not (Test-Path -LiteralPath (Join-Path $Frontend 'node_modules\@playwright\test'))) {
        Write-Step 'frontend: npm ci (node_modules belum lengkap)'
        Push-Location $Frontend
        try { & npm ci } finally { Pop-Location }
        if ($LASTEXITCODE -ne 0) { throw "npm ci gagal (exit $LASTEXITCODE)" }
    }

    $browserRoot = Join-Path $env:LOCALAPPDATA 'ms-playwright'
    $hasChromium = $false
    if (Test-Path -LiteralPath $browserRoot) {
        $hasChromium = [bool](Get-ChildItem -LiteralPath $browserRoot -Directory -Filter 'chromium-*' -ErrorAction SilentlyContinue)
    }
    if (-not $hasChromium) {
        Write-Step 'playwright: install chromium (browser belum ada)'
        Push-Location $Frontend
        try { & npx playwright install chromium } finally { Pop-Location }
        if ($LASTEXITCODE -ne 0) { throw "playwright install gagal (exit $LASTEXITCODE)" }
    }
}

function Ensure-LocalStack {
    if (-not (Test-Http 'http://localhost:8080/api/v1/health')) {
        Write-Step 'backend belum sehat; menyiapkan docker + backend lewat vms.ps1'
        & $Vms docker start
        & $Vms be start
    }
    if (-not (Test-Http 'http://localhost:3210/login')) {
        Write-Step 'frontend belum hidup; menyalakan lewat vms.ps1'
        & $Vms fe start
    }

    if (-not (Wait-Http 'http://localhost:8080/api/v1/health' 90)) {
        throw 'backend tidak sehat di http://localhost:8080/api/v1/health. Cek: vms be logs'
    }
    if (-not (Wait-Http 'http://localhost:3210/login' 90)) {
        throw 'frontend tidak hidup di http://localhost:3210/login. Cek: vms fe logs'
    }
    Write-Ok 'stack lokal siap (backend :8080 + frontend :3210)'
}

$mode = $Mode.ToLower()
$isLive = $mode -in @('live', 'prod', 'production')
$isCheck = $mode -in @('check', 'status', 'preflight')
$isLiveCheck = $mode -in @('live-check', 'livecheck', 'prod-check', 'production-check')

if (-not ($isLive -or $isCheck -or $isLiveCheck -or $mode -in @('local', 'dev'))) {
    Write-Err2 "mode tidak dikenal: '$Mode' (pakai: local | live | check | live-check)"
    exit 2
}

if ($isLiveCheck) {
    try {
        Assert-LiveTarget
        exit 0
    } catch {
        Write-Err2 $_.Exception.Message
        exit 1
    }
}

if ($isCheck) {
    Write-Step 'cek stack lokal (tanpa menjalankan test)'
    $be = Test-Http 'http://localhost:8080/api/v1/health'
    $fe = Test-Http 'http://localhost:3210/login'
    if ($be) { Write-Ok 'backend  :8080 sehat' } else { Write-Err2 'backend  :8080 TIDAK sehat' }
    if ($fe) { Write-Ok 'frontend :3210 hidup' } else { Write-Err2 'frontend :3210 TIDAK hidup' }
    if ($be -and $fe) { exit 0 } else { exit 1 }
}

Ensure-Dependencies

if ($isLive) {
    try {
        Assert-LiveTarget
    } catch {
        Write-Err2 $_.Exception.Message
        exit 1
    }

    Write-Host ''
    Write-Warn2 'MODE LIVE: suite menulis ke PRODUCTION https://vms.thckalbar.com'
    Write-Host '    - preflight di atas hanya GET /health; belum ada data yang ditulis' -ForegroundColor Yellow
    Write-Host '    - membuat lalu menghapus kunjungan nyata + akun sementara' -ForegroundColor Yellow
    Write-Host '    - mengunggah file ke bucket prod; objek TIDAK ikut terhapus (MinIO internal)' -ForegroundColor Yellow
    Write-Host "    - 66 spec; project setup dilewati, login dipacing $LivePacingMs ms (rate limit 5/menit/IP)" -ForegroundColor Yellow
    Write-Host ''
    $answer = Read-Host "Ketik LIVE untuk melanjutkan"
    if ($answer -cne 'LIVE') {
        Write-Host 'Dibatalkan. Tidak ada request test ke production.' -ForegroundColor Gray
        exit 1
    }

    Set-LiveE2EEnv
    Write-Step "menjalankan E2E headed ke $LiveUrl"
    Push-Location $Frontend
    try { & npm run e2e -- --project=e2e --no-deps --headed } finally { Pop-Location }
} else {
    Ensure-LocalStack
    Set-LocalE2EEnv

    Write-Step 'menjalankan E2E headed ke localhost:3210'
    Push-Location $Frontend
    try { & npm run e2e:headed } finally { Pop-Location }
}

$code = $LASTEXITCODE
if ($null -eq $code) { $code = 1 }
Write-Host ''
if ($code -eq 0) {
    Write-Ok 'E2E PASSED'
} else {
    Write-Err2 "E2E FAILED (exit $code)"
}
Write-Host "    report: $Frontend\playwright-report\index.html" -ForegroundColor Gray
exit $code
