<#
.SYNOPSIS
  Launcher kios: membuka layar gate (/gate) dalam mode kios DAN mengaktifkan
  kamera di origin HTTP (tanpa HTTPS).

.DESCRIPTION
  Usage:
      vms-kiosk
      vms-kiosk -Origin http://10.11.6.110
      vms-kiosk -Origin https://vms.thckalbar.com
      vms-kiosk -Path /gate -Browser edge
      vms-kiosk -NoKiosk          # jendela biasa, bukan mode kios

  Kenapa ada launcher ini:
  Browser hanya memberi `navigator.mediaDevices` pada SECURE CONTEXT
  (https://, atau http://localhost). Produksi yang dilayani HTTP polos di IP
  LAN berarti `navigator.mediaDevices` TIDAK ADA sama sekali -> kamera tak
  bisa dipakai dan tak ada prompt izin yang bisa muncul.

  Switch Chrome/Edge berikut membuat origin itu diperlakukan sebagai secure
  tanpa harus pasang sertifikat:
      --unsafely-treat-insecure-origin-as-secure=<origin>
  Diverifikasi terhadap Chrome asli: tanpa switch -> isSecureContext=false &
  getUserMedia tak bisa dipanggil; dengan switch -> isSecureContext=true &
  getUserMedia berhasil mengembalikan video track.

  CATATAN KEAMANAN: switch ini membuat origin dianggap tepercaya untuk API
  ber-secure-context (kamera, clipboard, service worker). Trafik tetap TIDAK
  terenkripsi sehingga bisa disadap di jaringan. Untuk kios milik sendiri di
  jaringan internal itu biasanya dapat diterima; untuk jaringan bersama,
  pakai HTTPS (mis. tunnel Cloudflare) sebagai gantinya.

  Chrome mensyaratkan switch ini dipakai pada profil NON-default, jadi
  launcher memakai user-data-dir khusus (tidak menyentuh profil pribadi).

  Loader ini TIDAK mengubah server, repo, atau data apa pun. Ia hanya
  membuka browser.
#>
[CmdletBinding()]
param(
    # Origin aplikasi yang dibuka (tanpa path).
    [string]$Origin = $(if ($env:THC_VMS_ORIGIN) { $env:THC_VMS_ORIGIN } else { 'http://10.11.6.110' }),
    # Path di dalam aplikasi.
    [string]$Path = '/gate',
    # chrome | edge | auto
    [string]$Browser = 'auto',
    # Buka jendela biasa, bukan mode kios layar penuh.
    [switch]$NoKiosk,
    # Tampilkan perintah yang akan dijalankan lalu berhenti (tanpa membuka browser).
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$RepoRoot = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }

# Muat definisi vms.ps1 tanpa menjalankan dispatch-nya.
. (Join-Path $RepoRoot "vms.ps1")

$Origin = $Origin.TrimEnd('/')
$Url = "$Origin$Path"

# ---- cari browser ----
function Resolve-Browser([string]$wanted) {
    $candidates = if ($wanted -eq 'edge') {
        @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe")
    }
    else {
        @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
          "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
          "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
          "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe")
    }
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c)) { return $c }
    }
    return $null
}

$browserExe = Resolve-Browser $Browser
if (-not $browserExe) {
    Write-Err2 "Browser tidak ditemukan (butuh Chrome atau Edge). Pasang salah satu, atau jalankan vms-kiosk dari browser yang ada."
    exit 1
}
$browserName = Split-Path -Leaf $browserExe

# ---- cek origin bisa dijangkau ----
Write-Step "memeriksa origin $Origin"
try {
    # Endpoint health BE ada di /api/v1/health. Status 404 pun berarti server
    # menjawab, jadi origin hidup - yang penting bukan Availability-nya.
    # Catatan: -SkipHttpErrorCheck hanya ada di PowerShell 7; skrip ini harus
    # jalan juga di Windows PowerShell 5.1, jadi error ditangkap manual.
    $probe = Invoke-WebRequest -Uri "$Origin/api/v1/health" -TimeoutSec 12 -UseBasicParsing -ErrorAction Stop
    Write-Ok "origin hidup (HTTP $($probe.StatusCode))"
}
catch {
    $status = 0
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    if ($status -gt 0) {
        Write-Ok "origin menjawab (HTTP $status) - server hidup"
    }
    else {
        Write-Warn2 "tidak bisa menghubungi $Origin ($($_.Exception.Message))"
        Write-Info "launcher tetap dibuka; periksa jaringan/VPN ke $Origin."
    }
}

# ---- susun argumen ----
$profileDir = Join-Path $env:LOCALAPPDATA 'thc-vms-kiosk'
$args = @(
    # Wajib: perlakukan origin ini sebagai secure agar mediaDevices tersedia.
    "--unsafely-treat-insecure-origin-as-secure=$Origin",
    # Chrome menolak switch tsb pada profil default -> profil khusus kios.
    "--user-data-dir=$profileDir",
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--disable-features=Translate'
)
if ($NoKiosk) {
    $args += "--app=$Url"
}
else {
    $args += '--kiosk'
    $args += "--app=$Url"
}

Write-Step "menjalankan $browserName (mode kios) -> $Url"
Write-Info "switch: --unsafely-treat-insecure-origin-as-secure=$Origin"
Write-Info "profil kios: $profileDir"
Write-Info "tutup jendela ini untuk menghentikan kios."

if ($DryRun) {
    Write-Info 'DRY RUN - perintah yang akan dijalankan:'
    Write-Info ('  "' + $browserExe + '" ' + ($args -join ' '))
    exit 0
}

$proc = Start-Process -FilePath $browserExe -ArgumentList $args -PassThru
Write-Ok "browser jalan (PID $($proc.Id))"
