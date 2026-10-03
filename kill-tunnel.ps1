# kill-tunnel.ps1 — pembunuh cloudflared nyangkut (yatim / bandel).
#
# Pakai:  .\kill-tunnel.ps1
#         (klik kanan > Run with PowerShell juga bisa)
#
# Kerja:  1) bunuh SEMUA proses bernama cloudflared (Stop-Process -Force,
#            fallback taskkill /F /IM /T bila masih hidup),
#         2) verifikasi tidak ada sisa + port metrics 20241/20242 bebas.
#
# Catatan: tunnel demo yang sedang aktif ikut mati (link PM putus).
#          Jalanin ini saat TIDAK demo, atau siap `.\vms-tunnel 3210` ulang.
#          Bila muncul Access denied, ulangi dari terminal Run as Administrator.

[CmdletBinding()]
param()

$ErrorActionPreference = 'SilentlyContinue'

function Say-Ok([string]$m) { Write-Host "    OK   $m" -ForegroundColor Green }
function Say-Warn([string]$m) { Write-Host "    WARN $m" -ForegroundColor Yellow }
function Say-Fail([string]$m) { Write-Host "    FAIL $m" -ForegroundColor Red }

Write-Host '==> kill-tunnel: memburu cloudflared nyangkut'

$victims = @(Get-Process -Name 'cloudflared' -ErrorAction SilentlyContinue)
if ($victims.Count -eq 0) {
    Say-Ok 'tidak ada proses cloudflared yang hidup'
} else {
    foreach ($v in $victims) {
        Write-Host ("    ... PID " + $v.Id + " (start " + $v.StartTime.ToString('HH:mm:ss') + ")")
    }
    $victims | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 1500
    $left = @(Get-Process -Name 'cloudflared' -ErrorAction SilentlyContinue)
    if ($left.Count -gt 0) {
        Say-Warn 'masih ada yang bandel, naik ke taskkill /F /T'
        & taskkill /F /IM cloudflared.exe /T | Out-Null
        Start-Sleep -Milliseconds 1500
        $left = @(Get-Process -Name 'cloudflared' -ErrorAction SilentlyContinue)
    }
    if ($left.Count -eq 0) {
        Say-Ok ("semua cloudflared mati (" + $victims.Count + " proses)")
    } else {
        Say-Fail ($left.Count.ToString() + ' proses menolak mati; ulangi dari terminal Run as Administrator.')
        exit 1
    }
}

Write-Host '==> kill-tunnel: cek port metrics'
$allFree = $true
foreach ($p in @(20241, 20242)) {
    $c = Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) {
        $owner = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
        $name = if ($owner) { $owner.ProcessName } else { '?' }
        Say-Warn ("port " + $p + " masih dipegang PID " + $c.OwningProcess + " (" + $name + ")")
        $allFree = $false
    } else {
        Say-Ok ("port " + $p + " bebas")
    }
}

if ($allFree) {
    Say-Ok 'beres. `.\vms-tunnel 3210` siap jalan tanpa rebutan port.'
    exit 0
} else {
    Say-Fail 'masih ada port metrics kepakai non-cloudflared; lihat baris WARN di atas.'
    exit 1
}
