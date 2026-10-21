# vms-export-sync.ps1 - export data dev (database + object storage) untuk
# disinkronkan ke VPS produksi.
#
# Menghasilkan dua artefak di folder tujuan:
#   csv/*.csv         8 tabel domain (visit_request, visitor, visit_purpose,
#                     status_history, check_in, check_out, notification,
#                     audit_log) - master data (users/location/purpose/vendor)
#                     TIDAK ikut, supaya kredensial login produksi utuh.
#   objects.tar.gz    dump bucket object storage lokal (struktur bucket/key).
#
# Tidak menyentuh database lokal (hanya dibaca) dan tidak mengubah apa pun
# di VPS. Transfer + eksekusi sinkronisasi dilakukan manual,see
# deploy/sync-local-data.sh (dijalankan di VPS).
#
# Contoh:
#   .\vms-export-sync.ps1
#   .\vms-export-sync.ps1 -OutDir D:\thc-vms-sync
<#
.SYNOPSIS
    Export data dev (CSV + object storage) untuk sinkronisasi ke VPS.
.DESCRIPTION
    Menjalankan container lokal (postgres + minio) dan mengekstrak:
      - 8 tabel domain sebagai CSV (byte-exact, header + data)
      - seluruh objek bucket sebagai objects.tar.gz
    Folder tujuan dibersihkan lebih dulu agar tidak ada sisa versi lama.
.PARAMETER OutDir
    Folder tujuan artefak. Default: <temp>\thc-vms-sync
#>
[CmdletBinding()]
param(
    [string]$OutDir = (Join-Path ([System.IO.Path]::GetTempPath()) 'thc-vms-sync'),
    [string]$PostgresContainer = 'thc-vms-postgres',
    [string]$MinioContainer = 'thc-vms-minio',
    [string]$DbUser = 'thc_user',
    [string]$DbName = 'thc_vms_db',
    [string]$MinioAlias = 'local',
    [string]$MinioEndpoint = 'http://127.0.0.1:9000',
    [string]$MinioUser = 'minioadmin',
    [string]$MinioSecret = 'minioadmin'
)

$ErrorActionPreference = 'Stop'

# Tabel yang diekspor, urut sesuai dependensi foreign key.
$Tables = @(
    'visit_request',
    'visitor',
    'visit_purpose',
    'status_history',
    'check_in',
    'check_out',
    'notification',
    'audit_log'
)

function Write-Step($message) {
    Write-Host "==> $message" -ForegroundColor Cyan
}

function Invoke-Docker {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
    $output = & docker @Args 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "docker $($Args -join ' ') gagal: $output"
    }
    return $output
}

Write-Step "memeriksa container lokal"
$running = Invoke-Docker ps --format '{{.Names}}'
foreach ($container in @($PostgresContainer, $MinioContainer)) {
    if ($running -notcontains $container) {
        throw "container '$container' tidak jalan. Jalankan dulu '.\vms.ps1 start'."
    }
}

$csvDir = Join-Path $OutDir 'csv'
if (Test-Path -LiteralPath $OutDir) {
    Remove-Item -LiteralPath $OutDir -Recurse -Force
}
New-Item -ItemType Directory -Path $csvDir -Force | Out-Null

Write-Step "mengekspor 8 tabel domain ke CSV"
foreach ($table in $Tables) {
    # SQL ditulis ke file lalu dieksekusi dengan `psql -f` di dalam container.
    # Cara ini menghindari quote bersarang pada argumen `docker exec` (yang
    # merusak argumen di PowerShell) dan menulis file byte-exact di sisi
    # server, jadi tidak ada line ending yang ditulis ulang dan tidak ada
    # baris kosong tambahan di akhir - keduanya merusak COPY.
    $sqlFile = Join-Path $env:TEMP "thc-export-$table.sql"
    Set-Content -LiteralPath $sqlFile -Encoding ascii -NoNewline -Value "COPY (SELECT * FROM $table) TO '/tmp/$table.csv' WITH (FORMAT csv, HEADER true);"
    Invoke-Docker cp $sqlFile "$PostgresContainer`:/tmp/export.sql" | Out-Null
    Invoke-Docker exec $PostgresContainer psql -U $DbUser -d $DbName -q -v ON_ERROR_STOP=1 -f /tmp/export.sql | Out-Null
    Invoke-Docker cp "$PostgresContainer`:/tmp/$table.csv" (Join-Path $csvDir "$table.csv") | Out-Null
    Remove-Item -LiteralPath $sqlFile -Force
    $rows = (Get-Content -LiteralPath (Join-Path $csvDir "$table.csv") | Measure-Object -Line).Lines - 1
    Write-Host ("    {0,-16} {1,6} baris" -f $table, $rows)
}

Write-Step "menyalin objek object storage lokal"
Invoke-Docker exec $MinioContainer sh -c "mc alias set $MinioAlias $MinioEndpoint $MinioUser $MinioSecret >/dev/null 2>&1; rm -rf /tmp/sync-obj; mkdir -p /tmp/sync-obj; mc cp --recursive $MinioAlias/thc-vms-bucket /tmp/sync-obj/ >/dev/null 2>&1" | Out-Null
Invoke-Docker cp "$MinioContainer`:/tmp/sync-obj" (Join-Path $OutDir 'objects') | Out-Null

$objectsRoot = Join-Path $OutDir 'objects'
$bucketDir = Get-ChildItem -LiteralPath $objectsRoot -Directory | Select-Object -First 1
if (-not $bucketDir) {
    throw "bucket lokal kosong - tidak ada objek untuk disalin"
}
$tarPath = Join-Path $OutDir 'objects.tar.gz'
if (Test-Path -LiteralPath $tarPath) {
    Remove-Item -LiteralPath $tarPath -Force
}
& tar -czf $tarPath -C $OutDir 'objects' | Out-Null

$objectCount = (Get-ChildItem -LiteralPath $bucketDir.FullName -Recurse -File | Measure-Object).Count
$totalSize = [math]::Round((Get-Item -LiteralPath $tarPath).Length / 1MB, 2)
Write-Host ("    {0} objek, tar.gz {1} MB" -f $objectCount, $totalSize)

Write-Host ''
Write-Step "artefak siap di $OutDir" -ForegroundColor Green
Write-Host "  csv/            : 8 CSV tabel domain"
Write-Host "  objects.tar.gz  : dump bucket lokal"
Write-Host ''
Write-Host 'Transfer ke VPS (pakai kredensial user vms), lalu jalankan:' -ForegroundColor Yellow
Write-Host "  scp -r `"$csvDir`" vms@10.11.6.110:/home/vms/thc-vms-sync/"
Write-Host "  scp `"$tarPath`" vms@10.11.6.110:/home/vms/thc-vms-sync/"
Write-Host '  ssh vms@10.11.6.110'
Write-Host '  bash /home/vms/thc-vms/deploy/sync-local-data.sh'
