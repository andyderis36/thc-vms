<#
.SYNOPSIS
  Satu perintah untuk demo remote: tunnel Cloudflare + setup env otomatis.

.DESCRIPTION
  Usage:
      vms-tunnel [port]

  Contoh:
      vms-tunnel          # tunnel FE di 3210 (default)
      vms-tunnel 3210     # sama, eksplisit
      vms-tunnel 4000     # FE jalan di port lain

  Alur: adopsi server manual bila perlu -> Share-Start (2 tunnel + tulis
  env + restart server) -> print 1 link buat PM -> tunggu di foreground.
  Tekan Ctrl+C untuk berhenti: tunnel dimatikan, env dikembalikan, server
  di-restart ke mode local-only. Menutup terminal tanpa Ctrl+C bisa
  meninggalkan tunnel yatim — jalankan `vms share stop` untuk bereskan.

  Server BE+FE harus sudah jalan (via `vms start` atau manual — yang manual
  akan ditawari adopsi dulu, tidak pernah di-kill diam-diam).
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)][string]$Port = "3210"
)

$ErrorActionPreference = 'Stop'
$RepoRoot = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }

# Muat definisi vms.ps1 tanpa menjalankan dispatch-nya.
. (Join-Path $RepoRoot "vms.ps1")

function Get-PortOwnerPid([int]$Port) {
    $conn = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $conn) { return $null }
    return $conn.OwningProcess
}

# ---- adopsi server manual (prompt eksplisit, tidak pernah kill diam-diam) ----
foreach ($spec in @(@{ Name = 'be'; Port = 8080 }, @{ Name = 'fe'; Port = $Port })) {
    $portNum = [int]$spec.Port
    if (Get-TrackedPid $spec.Name) { continue }
    $owner = Get-PortOwnerPid $portNum
    if (-not $owner) {
        Write-Err2 "$($spec.Name): port $portNum kosong. Jalankan 'vms start' dulu."
        exit 1
    }
    $proc = Get-Process -Id $owner -ErrorAction SilentlyContinue
    $pname = if ($proc) { $proc.ProcessName } else { 'unknown' }
    if (Test-ProtectedProcess $owner $pname) {
        Write-Err2 "$($spec.Name): port $portNum dipegang proses sistem ($pname) - tidak disentuh."
        exit 1
    }
    $answer = Read-Host "  $($spec.Name) jalan manual ($pname PID $owner). Adopsi ke vms agar bisa di-restart otomatis? [Y]a/[B]atal"
    if ($answer -notin @('Y', 'y', 'ya', 'Ya', 'yes', 'Yes', 'YES')) {
        Write-Info 'dibatalkan.'
        exit 1
    }
    New-Runtime
    "$owner" | Set-Content -LiteralPath (Get-PidFile $spec.Name)
    if ($spec.Name -eq 'fe') {
        "$portNum" | Set-Content -LiteralPath (Get-PortFile 'fe')
    }
    Write-Ok "$($spec.Name) diadopsi (PID $owner)"
}

# ---- inti: mesin vms share yang sudah ada ----
Share-Start $Port

$st = Share-IsActive
if (-not $st) {
    Write-Err2 'sharing gagal dimulai (lihat pesan di atas).'
    # Diagnosis: tunjukkan komponen mana yang mati + di mana lognya, agar
    # tidak tebak-tebakan.
    try {
        $last = Get-Content -LiteralPath (Join-Path $Runtime 'share.json') -Raw | ConvertFrom-Json
        foreach ($t in @(@{ N = 'FE'; P = $last.fePid; L = 'fe' }, @{ N = 'BE'; P = $last.bePid; L = 'be' })) {
            $alive = $false
            try { $alive = [bool](Get-Process -Id $t.P -ErrorAction Stop) } catch { }
            $state = if ($alive) { 'HIDUP' } else { 'MATI' }
            Write-Info ("tunnel {0} (PID {1}): {2}; log: .runtime/{3}.tunnel.log" -f $t.N, $t.P, $state, $t.L)
        }
    } catch { }
    exit 1
}
Write-Host ''
Write-Host '  TETAP BUKA terminal ini selama demo. Ctrl+C = berhenti + kembalikan lokal.' -ForegroundColor Yellow
Write-Host ''

# Tunggu foreground: mati (Ctrl+C / tutup) -> finally selalu bereskan.
try {
    Wait-Process -Id $st.fePid, $st.bePid
} finally {
    Write-Host ''
    Write-Step 'vms-tunnel: berhenti, mengembalikan ke local-only'
    Share-Stop
}
