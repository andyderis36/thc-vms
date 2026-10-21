<#
.SYNOPSIS
  Simpan & verifikasi token Gitea untuk push ke repo (rotasi PAT).

.DESCRIPTION
  Usage:
      vms-git-auth                      # prompted: tempel token baru
      vms-git-auth -Token <token>       # non-interaktif (JANGAN lewat argumen di mesin bersama)
      vms-git-auth -Check               # hanya verifikasi token yang tersimpan

  Alur:
    1. Gitea -> Settings -> Applications -> Generate New Token
       scope minimal: read:repository + write:repository
    2. Tempel token ke prompt (tidak dicetak ke layar/riwayat).
    3. Token disimpan di Git Credential Manager untuk host git.thckalbar.com
       (TIDAK pernah ditulis ke file repo atau URL remote).
    4. Token diverifikasi terhadap API repo.
    5. Remote diperiksa: HTTPS + tanpa kredensial yang tertanam di URL.

  Token dipakai hanya untuk push. Itu sebabnya rotasi cukup: revoke token
  lama di Gitea, generate yang baru, lalu jalankan skrip ini lagi.
#>
[CmdletBinding()]
param(
    # Token Gitea. Kalau kosong, skrip menanya lewat prompt aman.
    [string]$Token,
    # Hanya verifikasi token yang sudah tersimpan.
    [switch]$Check
)

$ErrorActionPreference = 'Stop'
$RepoRoot = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }

# Muat definisi vms.ps1 tanpa menjalankan dispatch-nya.
. (Join-Path $RepoRoot "vms.ps1")

$GitHost = 'git.thckalbar.com'
$ApiBase = "https://$GitHost/api/v1"

function Get-StoredToken {
    # Penutup here-string harus sendirian di barisnya (PowerShell 5.1), jadi
    # isinya masuk ke variabel dulu, baru dipipe.
    $filled = @"
protocol=https
host=$GitHost

"@
    foreach ($line in ($filled | git credential fill 2>$null)) {
        if ($line -like 'password=*') { return $line.Substring(9) }
    }
    return $null
}

function Save-Token([string]$value, [string]$user) {
    $credentialInput = "protocol=https`nhost=$GitHost`nusername=$user`npassword=$value`n`n"
    $credentialInput | git credential approve 2>$null
}

function Test-Token([string]$value) {
    try {
        $r = Invoke-WebRequest -Uri "$ApiBase/repos/thckalbar/vms" -Headers @{ Authorization = "token $value" } -TimeoutSec 20 -UseBasicParsing -ErrorAction Stop
        return @{ ok = ($r.StatusCode -eq 200); status = $r.StatusCode; login = $null }
    }
    catch {
        $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
        return @{ ok = $false; status = $status; login = $null }
    }
}

Write-Step "menyiapkan token Gitea untuk $GitHost"

if (-not $Check) {
    if ([string]::IsNullOrWhiteSpace($Token)) {
        $secure = Read-Host '  Tempel token Gitea (tidak akan dicetak)' -AsSecureString
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try { $Token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    }
    if ([string]::IsNullOrWhiteSpace($Token)) {
        Write-Err2 'token kosong.'
        exit 1
    }
    $Token = $Token.Trim()

    # Username = pemilik token. API /user butuh scope read:user; kalau tidak
    # diizinkan, token tetap sah untuk push dengan username sembarang.
    $login = 'oauth2'
    try {
        $u = Invoke-WebRequest -Uri "$ApiBase/user" -Headers @{ Authorization = "token $Token" } -TimeoutSec 15 -UseBasicParsing -ErrorAction Stop
        $login = (($u.Content | ConvertFrom-Json).login)
    }
    catch {
        Write-Info "scope read:user tidak ada pada token; pakai username default '$login'."
    }

    $probe = Test-Token $Token
    if (-not $probe.ok) {
        Write-Err2 "token ditolak server (HTTP $($probe.status)). Cek scope: read:repository + write:repository, dan belum dicabut."
        exit 1
    }
    Write-Ok "token valid (HTTP $($probe.status))"

    Save-Token $Token $login
    Write-Ok "token disimpan di Git Credential Manager untuk $GitHost"
    $Token = $null
}

# ---- verifikasi token yang tersimpan ----
$stored = Get-StoredToken
if (-not $stored) {
    Write-Err2 "tidak ada token tersimpan untuk $GitHost. Jalankan 'vms-git-auth' lalu tempel token."
    exit 1
}
$probe = Test-Token $stored
if (-not $probe.ok) {
    Write-Err2 "token tersimpan ditolak server (HTTP $($probe.status)). Buat token baru lalu jalankan ulang."
    exit 1
}
Write-Ok "token tersimpan valid (HTTP $($probe.status))"

# ---- remote harus HTTPS & tanpa kredensial di URL ----
$remote = (git remote get-url origin 2>$null)
if (-not $remote) {
    Write-Err2 'remote "origin" belum ada.'
    exit 1
}
if ($remote -match 'https?://[^/]*@') {
    Write-Err2 "remote memuat kredensial di URL ($remote). Buang bagian sebelum @ - token tidak boleh ada di URL."
    exit 1
}
if ($remote -notlike 'https://*') {
    Write-Warn2 "remote masih bukan HTTPS ($remote)."
    Write-Info "SSH butuh push bertanda tangan di Gitea 1.27; HTTPS + PAT lebih ringkas."
}
else {
    Write-Ok "remote HTTPS: $remote"
}

Write-Info ''
Write-Info 'Langkah berikutnya:'
Write-Info '  git push origin dev'
Write-Info '  git switch main; git merge --no-ff dev -m "Release: ..."; git push origin main   # = deploy'
