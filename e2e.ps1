<#
.SYNOPSIS
  One-click runner for the THC-VMS Playwright E2E suite.

.DESCRIPTION
  Usage:
      e2e.cmd                     # LOCAL headed (default): pastikan stack hidup, lalu jalankan suite
      e2e.cmd local -SlowMo 250   # LOCAL dengan pacing demo (slowMo 250 ms per aksi)
      e2e.cmd list                # cetak inventaris authoritative (Files/Tests); tidak menjalankan test
      e2e.cmd check               # cek stack lokal saja, tidak menjalankan test
      e2e.cmd live-check          # cek production via GET /health saja, tidak menulis data
      e2e.cmd live                # PRODUCTION headed (menulis data nyata; wajib ketik LIVE)
      e2e-live.cmd                # shortcut double-click untuk mode live
      e2e.cmd sweep               # DRY-RUN daftar artefak E2E sisa di production (tidak menghapus)
      e2e.cmd sweep -Apply        # HAPUS artefak E2E sisa di production (204/404 saja; lainnya batal)
      e2e.cmd local -DryRun       # cetak command line + env yang akan dipakai, tanpa menjalankan test

  Local mode memakai backend :8080 + frontend :3210 yang sudah berjalan. Bila
  salah satu mati, script menyalakannya lewat vms.ps1 (docker -> be -> fe).
  Live mode TIDAK menyalakan stack lokal; ia menembak https://vms.thckalbar.com.

  Playwright yang dipakai adalah paket lokal di frontend/node_modules (bukan MCP).

  Pacing (slowMo) default 0 ms supaya run otomatis secepat mungkin. Untuk demo,
  pakai `e2e.cmd local -SlowMo 250` atau set $env:E2E_SLOWMO=250. Pacing live
  (E2E_LIVE_PACING_MS, default 13000) TIDAK terpengaruh oleh -SlowMo.

.PARAMETER Mode
  local (default) | live | check | live-check | list.

.PARAMETER SlowMo
  slowMo per aksi Playwright dalam milidetik, hanya berlaku saat headed.
  Default 0. Override juga bisa lewat $env:E2E_SLOWMO (argumen menang).

.PARAMETER List
  Hanya cetak inventaris suite dari `playwright test --list --reporter=json`
  lalu exit 0. Sama dengan `e2e.cmd list`.

.PARAMETER Apply
  Hanya untuk mode `sweep`: benar-benar hapus artefak E2E sisa di production.
  Tanpa flag ini, `sweep` selalu DRY-RUN (hanya mendaftar).

.PARAMETER DryRun
  Cetak command line + env yang akan dieksekusi lalu exit 0. Tidak menyalakan
  docker/backend/frontend, tidak memasang dependency, tidak menjalankan test.

.EXAMPLE
  e2e.cmd check

.EXAMPLE
  e2e.cmd local -DryRun
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)][string]$Mode = 'local',
    [int]$SlowMo = 0,
    [switch]$List,
    [switch]$Apply,
    [Alias('WhatIf')][switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$RepoRoot = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$Frontend = Join-Path $RepoRoot 'frontend'
$PlaywrightCli = Join-Path $Frontend 'node_modules\.bin\playwright.cmd'
$SweepScript = Join-Path $Frontend 'e2e\sweep.ts'
$Vms = Join-Path $RepoRoot 'vms.ps1'
$LiveUrl = 'https://vms.thckalbar.com'
$LivePacingMs = if ($env:E2E_LIVE_PACING_MS) { $env:E2E_LIVE_PACING_MS } else { '13000' }

# Cache script-scope: probe `playwright --list` (2-4 detik) hanya sekali per invocation.
$script:E2EInventoryCache = $null

# -SlowMo eksplisit menang atas env; kalau tidak diisi, hormati $env:E2E_SLOWMO.
if (-not $PSBoundParameters.ContainsKey('SlowMo')) {
    $envSlowMo = $env:E2E_SLOWMO
    if ($envSlowMo -and $envSlowMo -match '^\d+$') { $SlowMo = [int]$envSlowMo }
}

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "    OK   $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "    WARN $msg" -ForegroundColor Yellow }
function Write-Err2($msg) { Write-Host "    FAIL $msg" -ForegroundColor Red }

# Perkiraan kasar dari disk (fallback). Bisa meleset: `test.describe`,
# test dinamis, dan multi-project tidak terlihat oleh hitungan literal ini.
function Get-E2ESpecStatsFromDisk {
    $specFiles = @(Get-ChildItem -LiteralPath (Join-Path $Frontend 'e2e\specs') -Filter '*.spec.ts' -ErrorAction SilentlyContinue)
    $testCount = 0
    foreach ($file in $specFiles) {
        $testCount += (Select-String -LiteralPath $file.FullName -Pattern 'test\(' -AllMatches).Matches.Count
    }
    return [pscustomobject]@{
        Files          = $specFiles.Count
        Tests          = $testCount
        PerProject     = @{}
        FilesByProject = @{}
        Source         = 'disk'
    }
}

# Telusuri node `suites` -> `specs` -> `tests` milik reporter JSON Playwright.
function Measure-E2ESuite($suite, $acc, $defaultFile) {
    if ($null -eq $suite) { return }
    $suiteFile = $defaultFile
    if ($suite.PSObject.Properties['file'] -and $suite.file) { $suiteFile = [string]$suite.file }

    foreach ($spec in @($suite.specs)) {
        if ($null -eq $spec) { continue }
        $tests = @($spec.tests)
        if ($tests.Count -eq 0) { continue }
        $file = $suiteFile
        if ($spec.PSObject.Properties['file'] -and $spec.file) { $file = [string]$spec.file }
        if ($file) { $acc.Files[$file] = $true }
        $acc.Tests += $tests.Count
        foreach ($t in $tests) {
            $proj = '(default)'
            if ($t.PSObject.Properties['projectName'] -and $t.projectName) { $proj = [string]$t.projectName }
            if (-not $acc.PerProject.ContainsKey($proj)) {
                $acc.PerProject[$proj] = 0
                $acc.FilesByProject[$proj] = @{}
            }
            $acc.PerProject[$proj] += 1
            if ($file) { $acc.FilesByProject[$proj][$file] = $true }
        }
    }

    foreach ($child in @($suite.suites)) { Measure-E2ESuite $child $acc $suiteFile }
}

# Sumber angka utama: Playwright sendiri. Kalau probe gagal, turun ke disk + WARN;
# probe statistik tidak boleh menggagalkan runner.
function Get-E2EInventory {
    if ($null -ne $script:E2EInventoryCache) { return $script:E2EInventoryCache }

    $inv = $null
    if (Test-Path -LiteralPath $PlaywrightCli) {
        try {
            # Playwright WAJIB dijalankan dari $Frontend agar config/testDir ketemu.
            # EAP dilonggarkan lokal: di PS 5.1 stderr native command menjadi
            # terminating error saat ErrorActionPreference='Stop'.
            $prevEap = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            Push-Location $Frontend
            try {
                $raw = (& $PlaywrightCli test --list --reporter=json 2>$null | Out-String)
                $exit = $LASTEXITCODE
            } finally {
                Pop-Location
                $ErrorActionPreference = $prevEap
            }
            if ($exit -ne 0) { throw "playwright --list exit $exit" }
            if (-not $raw -or -not $raw.Trim()) { throw 'playwright --list tidak menghasilkan output' }

            $json = $null
            try {
                $json = $raw | ConvertFrom-Json
            } catch {
                # Buang preamble non-JSON (mis. warning plugin) lalu parse objek JSON-nya.
                $start = $raw.IndexOf('{')
                $end = $raw.LastIndexOf('}')
                if ($start -lt 0 -or $end -le $start) { throw }
                $json = $raw.Substring($start, $end - $start + 1) | ConvertFrom-Json
            }

            $acc = @{ Files = @{}; Tests = 0; PerProject = @{}; FilesByProject = @{} }
            foreach ($suite in @($json.suites)) { Measure-E2ESuite $suite $acc $null }
            if ($acc.Tests -eq 0) { throw 'playwright --list tidak melaporkan test apa pun' }

            $inv = [pscustomobject]@{
                Files          = $acc.Files.Count
                Tests          = $acc.Tests
                PerProject     = $acc.PerProject
                FilesByProject = $acc.FilesByProject
                Source         = 'playwright --list'
            }
        } catch {
            Write-Warn2 "inventaris Playwright gagal ($($_.Exception.Message)); pakai hitung disk (perkiraan)"
            $inv = $null
        }
    } else {
        Write-Warn2 "Playwright CLI tidak ada di $PlaywrightCli; pakai hitung disk (perkiraan)"
    }

    if ($null -eq $inv) { $inv = Get-E2ESpecStatsFromDisk }
    $script:E2EInventoryCache = $inv
    return $inv
}

# Files/Tests untuk satu project ('' = seluruh suite, termasuk project dependensi).
function Get-E2ESpecStats([string]$Project = '') {
    $inv = Get-E2EInventory
    if (-not $Project) {
        return [pscustomobject]@{ Files = $inv.Files; Tests = $inv.Tests; Source = $inv.Source }
    }
    if ($inv.PerProject.ContainsKey($Project)) {
        return [pscustomobject]@{
            Files  = @($inv.FilesByProject[$Project].Keys).Count
            Tests  = $inv.PerProject[$Project]
            Source = $inv.Source
        }
    }
    if ($inv.Source -eq 'disk') {
        return [pscustomobject]@{ Files = $inv.Files; Tests = $inv.Tests; Source = $inv.Source }
    }
    return [pscustomobject]@{ Files = 0; Tests = 0; Source = $inv.Source }
}

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

function Test-DockerEngine {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & docker info 2>&1 | Out-Null
        return ($LASTEXITCODE -eq 0)
    } finally {
        $ErrorActionPreference = $prev
    }
}

function Ensure-DockerEngine {
    if (Test-DockerEngine) { return }

    $dockerDesktop = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
    if (-not (Test-Path -LiteralPath $dockerDesktop)) {
        throw 'Docker engine tidak berjalan dan Docker Desktop tidak ditemukan. Nyalakan Docker Desktop lalu ulangi.'
    }

    Write-Step 'Docker Desktop belum berjalan; menyalakan dan menunggu engine siap'
    Start-Process -FilePath $dockerDesktop | Out-Null
    $deadline = (Get-Date).AddSeconds(180)
    while ((Get-Date) -lt $deadline) {
        if (Test-DockerEngine) {
            Write-Ok 'Docker engine siap'
            return
        }
        Start-Sleep -Seconds 3
    }
    throw 'Docker engine tidak siap dalam 180 detik. Buka Docker Desktop secara manual lalu ulangi.'
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

# Sapuan artefak E2E sisa (kunjungan/akun/fasilitas) SEBELUM suite live.
# Tanpa -Apply hanya mendaftar (dry-run); dengan -Apply menghapus 204/404 dan
# membatalkan seluruh sapuan pada status lain. Kegagalan sweep = test tidak jalan.
function Invoke-E2ESweep([switch]$Apply) {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw 'node tidak ditemukan di PATH; sweep membutuhkan Node 24+ (type stripping)'
    }
    if (-not (Test-Path -LiteralPath $SweepScript)) {
        throw "script sweep tidak ada: $SweepScript"
    }

    $cliArgs = @($SweepScript)
    if ($Apply) { $cliArgs += '--apply' }

    Push-Location $Frontend
    try {
        # `.ts` ESM tanpa "type":"module" memicu MODULE_TYPELESS_PACKAGE_JSON;
        # peringatan itu derau, bukan kegagalan (Node 24 type stripping).
        & node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON @cliArgs | Out-Host
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($code -ne 0) {
        throw "sweep artefak E2E gagal (exit $code); tidak ada test yang dijalankan"
    }
}

function Ensure-Dependencies {
    if (-not (Test-Path -LiteralPath (Join-Path $Frontend 'node_modules\@playwright\test')) -or
        -not (Test-Path -LiteralPath $PlaywrightCli)) {
        Write-Step 'frontend: npm ci (node_modules/Playwright CLI belum lengkap)'
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
    $beHealth = Test-Http 'http://localhost:8080/api/v1/health'
    $beReady = Test-Http 'http://localhost:8080/api/v1/ready'
    $minioReady = Test-Http 'http://localhost:9000/minio/health/live'

    if (-not ($beHealth -and $beReady -and $minioReady)) {
        Write-Step 'stack lokal belum siap (DB/MinIO/backend); menyiapkan docker + backend lewat vms.ps1'
        Ensure-DockerEngine
        & $Vms docker start
        if ($beHealth -and -not $beReady) {
            Write-Step 'backend hidup tapi database belum siap; restart backend'
            & $Vms be restart
        } elseif (-not $beHealth) {
            & $Vms be start
        }
    }
    if (-not (Test-Http 'http://localhost:3210/login')) {
        Write-Step 'frontend belum hidup; menyalakan lewat vms.ps1'
        & $Vms fe start
    }

    if (-not (Wait-Http 'http://localhost:8080/api/v1/health' 90)) {
        throw 'backend tidak sehat di http://localhost:8080/api/v1/health. Cek: vms be logs'
    }
    if (-not (Wait-Http 'http://localhost:8080/api/v1/ready' 90)) {
        throw 'backend belum siap (DB/MinIO) di http://localhost:8080/api/v1/ready. Cek: vms docker logs; vms be logs'
    }
    if (-not (Wait-Http 'http://localhost:9000/minio/health/live' 90)) {
        throw 'MinIO tidak sehat di http://localhost:9000/minio/health/live. Cek: vms docker logs'
    }
    if (-not (Wait-Http 'http://localhost:3210/login' 90)) {
        throw 'frontend tidak hidup di http://localhost:3210/login. Cek: vms fe logs'
    }
    Write-Ok 'stack lokal siap (backend :8080 + DB + MinIO + frontend :3210)'
}

# Jalankan Playwright dan simpan exit code-nya. Output CLI dialirkan ke host
# (`Out-Host`) supaya tidak ikut menjadi return value fungsi ini. Exception
# (CLI hilang, dsb) dibiarkan naik ke pemanggil supaya tetap exit non-zero.
function Invoke-PlaywrightTest([string[]]$CliArgs) {
    $script:PlaywrightExitCode = $null
    Push-Location $Frontend
    try {
        & $PlaywrightCli @CliArgs | Out-Host
        $script:PlaywrightExitCode = $LASTEXITCODE
    } finally {
        Pop-Location
    }
}

function Format-Command([string]$Exe, [string[]]$CliArgs) {
    $parts = @("`"$Exe`"")
    foreach ($a in $CliArgs) {
        if ($a -match '[\s"]') { $parts += "`"$a`"" } else { $parts += $a }
    }
    return ($parts -join ' ')
}

function Show-DryRun([string[]]$CliArgs, [string]$Target) {
    $stats = Get-E2ESpecStats
    Write-Host ''
    Write-Step 'DRY RUN: tidak menyalakan stack, tidak memasang dependency, tidak menjalankan test'
    Write-Host "    mode       : $mode"
    Write-Host "    target     : $Target"
    Write-Host "    cwd        : $Frontend"
    Write-Host "    cmd        : $(Format-Command $PlaywrightCli $CliArgs)"
    Write-Host '    env        :'
    foreach ($name in @('E2E_BASE_URL', 'E2E_API_BASE_URL', 'E2E_FRONTEND_BASE_URL', 'E2E_LOGIN_PACING_MS', 'E2E_SKIP_STORAGE_CLEANUP', 'E2E_SLOWMO')) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($value) { Write-Host "                 $name=$value" }
    }
    Write-Host "    inventaris : $($stats.Tests) test dalam $($stats.Files) file (sumber: $($stats.Source))"
    Write-Host ''
    Write-Ok 'DRY RUN selesai; tidak ada test yang dijalankan'
}

$mode = $Mode.ToLower()
$isLive = $mode -in @('live', 'prod', 'production')
$isCheck = $mode -in @('check', 'status', 'preflight')
$isLiveCheck = $mode -in @('live-check', 'livecheck', 'prod-check', 'production-check')
$isList = $List -or ($mode -in @('list', 'ls', 'inventory', 'stats'))
$isSweep = $mode -eq 'sweep'

if (-not ($isLive -or $isCheck -or $isLiveCheck -or $isList -or $isSweep -or $mode -in @('local', 'dev'))) {
    Write-Err2 "mode tidak dikenal: '$Mode' (pakai: local | live | check | live-check | list | sweep)"
    exit 2
}

if ($isList) {
    Write-Step 'inventaris suite (playwright --list; tidak menjalankan test)'
    $inv = Get-E2EInventory
    $all = Get-E2ESpecStats
    Write-Host "    sumber   : $($inv.Source)"
    Write-Host "    TOTAL    : $($all.Tests) test dalam $($all.Files) file"
    $projectNames = @($inv.PerProject.Keys | Sort-Object)
    foreach ($p in $projectNames) {
        $ps = Get-E2ESpecStats $p
        Write-Host "    project  : $p = $($ps.Tests) test dalam $($ps.Files) file"
    }
    $setupStats = Get-E2ESpecStats 'setup'
    Write-Host ''
    Write-Host '    Catatan: `--list` tanpa --project sudah ikut menghitung project' -ForegroundColor Gray
    if ($setupStats.Tests -gt 0) {
        Write-Host "    dependensi, jadi `(--list --project=e2e)` melaporkan $($all.Tests) test / $($all.Files) file" -ForegroundColor Gray
        Write-Host "    juga (termasuk project 'setup' = $($setupStats.Tests) test)." -ForegroundColor Gray
    } else {
        Write-Host '    dependensi; angka TOTAL di atas sama dengan `--project=e2e`.' -ForegroundColor Gray
    }
    if ($inv.Source -eq 'disk') {
        Write-Warn2 'angka ini perkiraan dari disk, bukan dari Playwright'
    }
    exit 0
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

# Mode `sweep` selalu menembak production. Default DRY-RUN; `-Apply` menghapus.
if ($isSweep) {
    Set-LiveE2EEnv
    if ($Apply) {
        Write-Warn2 "sweep APPLY: menghapus artefak E2E sisa di PRODUCTION $LiveUrl"
    } else {
        Write-Step "sweep DRY-RUN: daftar artefak E2E sisa di production $LiveUrl (tidak menghapus)"
    }
    try {
        if ($Apply) { Invoke-E2ESweep -Apply } else { Invoke-E2ESweep }
    } catch {
        Write-Err2 $_.Exception.Message
        exit 1
    }
    exit 0
}

if ($isCheck) {
    Write-Step 'cek stack lokal (tanpa menjalankan test)'
    $be = Test-Http 'http://localhost:8080/api/v1/health'
    $beReady = Test-Http 'http://localhost:8080/api/v1/ready'
    $minio = Test-Http 'http://localhost:9000/minio/health/live'
    $fe = Test-Http 'http://localhost:3210/login'
    if ($be) { Write-Ok 'backend  :8080 health' } else { Write-Err2 'backend  :8080 health TIDAK sehat' }
    if ($beReady) { Write-Ok 'backend  :8080 ready (DB)' } else { Write-Err2 'backend  :8080 ready TIDAK siap (DB)' }
    if ($minio) { Write-Ok 'MinIO    :9000 health' } else { Write-Err2 'MinIO    :9000 TIDAK sehat' }
    if ($fe) { Write-Ok 'frontend :3210 hidup' } else { Write-Err2 'frontend :3210 TIDAK hidup' }
    if ($be -and $beReady -and $minio -and $fe) { exit 0 } else { exit 1 }
}

$pwArgs = @('test', '--headed')
$targetLabel = 'http://localhost:3210'

if ($isLive) {
    $pwArgs = @('test', '--project=e2e', '--no-deps', '--headed')
    $targetLabel = $LiveUrl
}

if ($DryRun) {
    if ($isLive) { Set-LiveE2EEnv } else { Set-LocalE2EEnv }
    Show-DryRun $pwArgs $targetLabel
    exit 0
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
    $specStats = Get-E2ESpecStats 'e2e'
    Write-Host "    - $($specStats.Tests) test dalam $($specStats.Files) spec (project e2e saja; setup dilewati, login dipacing $LivePacingMs ms)" -ForegroundColor Yellow
    Write-Host ''
    $answer = Read-Host 'Ketik LIVE untuk melanjutkan'
    if ($answer -cne 'LIVE') {
        Write-Host 'Dibatalkan. Tidak ada request test ke production.' -ForegroundColor Gray
        exit 1
    }

    Set-LiveE2EEnv
    Write-Step 'sweep artefak E2E sisa sebelum test (live)'
    try {
        Invoke-E2ESweep -Apply
    } catch {
        Write-Err2 $_.Exception.Message
        exit 1
    }
    Write-Step "menjalankan E2E headed ke $LiveUrl (slowMo $SlowMo ms)"
} else {
    Ensure-LocalStack
    Set-LocalE2EEnv

    $specStats = Get-E2ESpecStats
    Write-Step "menjalankan E2E headed ke localhost:3210 ($($specStats.Tests) test dalam $($specStats.Files) spec; slowMo $SlowMo ms)"
}

$code = 1
try {
    Invoke-PlaywrightTest $pwArgs
    $code = $script:PlaywrightExitCode
    if ($null -eq $code) { $code = 1 }
} catch {
    Write-Host ''
    Write-Err2 "E2E FAILED: $($_.Exception.Message)"
    if ($_.ScriptStackTrace) { Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray }
    $code = 1
}

Write-Host ''
if ($code -eq 0) {
    Write-Ok 'E2E PASSED'
} else {
    Write-Err2 "E2E FAILED (exit $code)"
}
Write-Host "    report: $Frontend\playwright-report\index.html" -ForegroundColor Gray
exit $code
