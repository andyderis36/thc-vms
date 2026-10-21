<#
.SYNOPSIS
  Simpan, verifikasi & rotasi token Gitea untuk push ke repo (PAT).

.DESCRIPTION
  Usage:
      vms-git-auth                      # prompted: tempel token baru
      vms-git-auth -Token <token>       # non-interaktif (JANGAN lewat argumen di mesin bersama)
      vms-git-auth -Check               # hanya verifikasi token yang sudah tersimpan
      vms-git-auth -RevokeOld 12,13     # cabut token lama dengan id tsb (id dari daftar)

  Alur:
    1. Gitea -> Settings -> Applications -> Generate New Token
       Scope: read:repository + write:repository  (WAJIB untuk push)
              read:user + write:user              (opsional tapi disarankan:
              supaya skrip bisa mencabut token lama sendiri)
       Beri masa berlaku pendek bila Gitea menawarkannya.
    2. Tempel token ke prompt (tidak dicetak ke layar/riwayat).
    3. Token disimpan di Git Credential Manager untuk host git.thckalbar.com
       (TIDAK pernah ditulis ke file repo atau URL remote).
    4. Token diverifikasi terhadap API repo.
    5. Kalau token punya scope read:user, skrip mencetak daftar token lain
       milik akun itu + perintah cabut siap pakai, sehingga token yang pernah
       bocor bisa dicabut tanpa ganggu repo.
    6. Remote diperiksa: HTTPS + tanpa kredensial yang tertanam di URL.

  Catatan: token dipakai hanya untuk push. Rotasi karena itu cukup: revoke
  token lama, generate yang baru, jalankan skrip ini lagi.
#>
[CmdletBinding()]
param(
    # Token Gitea. Kalau kosong, skrip menanya lewat prompt aman.
    [string]$Token,
    # Hanya verifikasi token yang sudah tersimpan.
    [switch]$Check,
    # Id token lama yang harus dicabut (pisahkan dengan koma).
    [string]$RevokeOld
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

function Invoke-Gitea([string]$method, [string]$path, [string]$value) {
    $headers = @{ Authorization = "token $value" }
    try {
        return Invoke-WebRequest -Method $method -Uri "$ApiBase$path" -Headers $headers -TimeoutSec 20 -UseBasicParsing -ErrorAction Stop
    }
    catch {
        $status = 0
        if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
        return @{ StatusCode = $status; Content = '' }
    }
}

function Get-TokenList([string]$value, [string]$login) {
    $r = Invoke-Gitea 'GET' "/users/$login/tokens?limit=100" $value
    if ($r.StatusCode -ne 200) { return $null }
    try { return ($r.Content | ConvertFrom-Json) } catch { return $null }
}

function Get-AccountLogin([string]$value) {
    $r = Invoke-Gitea 'GET' '/user' $value
    if ($r.StatusCode -ne 200) { return $null }
    try { return (($r.Content | ConvertFrom-Json).login) } catch { return $null }
}

function Remove-Token([string]$value, [string]$login, [string]$id) {
    $r = Invoke-Gitea 'DELETE' "/users/$login/tokens/$id" $value
    if ($r.StatusCode -eq 404) {
        # Sebagian versi Gitea mencabut lewat NAMA token, bukan id.
        $r = Invoke-Gitea 'DELETE' "/users/$login/tokens/$id" $value
    }
    return $r.StatusCode
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

    $login = Get-AccountLogin $Token
    if (-not $login) {
        $login = 'oauth2'
        Write-Info 'scope read:user tidak ada pada token; pakai username default.'
    }

    $r = Invoke-Gitea 'GET' '/repos/thckalbar/vms' $Token
    if ($r.StatusCode -ne 200) {
        Write-Err2 "token ditolak server (HTTP $($r.StatusCode)). Cek scope: read:repository + write:repository, dan belum dicabut."
        exit 1
    }
    Write-Ok "token valid (HTTP $($r.StatusCode))"

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
$r = Invoke-Gitea 'GET' '/repos/thckalbar/vms' $stored
if ($r.StatusCode -ne 200) {
    Write-Err2 "token tersimpan ditolak server (HTTP $($r.StatusCode)). Buat token baru lalu jalankan ulang."
    exit 1
}
Write-Ok "token tersimpan valid (HTTP $($r.StatusCode))"

$login = Get-AccountLogin $stored
if (-not $login) { $login = 'oauth2' }

# ---- daftar token lain milik akun (kalau scope read:user ada) ----
$tokenList = Get-TokenList $stored $login
if ($null -eq $tokenList) {
    Write-Info 'scope read:user tidak ada -> daftar token tidak bisa dibaca.'
    Write-Info 'cabut token lama manual di Gitea (Settings -> Applications).'
}
else {
    Write-Ok "daftar token akun terbaca ($(@($tokenList).Count) token)"
    foreach ($t in $tokenList) {
        Write-Info ("  id={0}  nama='{1}'  dibuat={2}" -f $t.id, $t.name, $t.created_at)
    }
    if ($RevokeOld) {
        $ids = $RevokeOld -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
        foreach ($id in $ids) {
            $code = Remove-Token $stored $login $id
            if ($code -eq 204 -or $code -eq 200) { Write-Ok "token id=$id dicabut" }
            else { Write-Warn2 "token id=$id gagal dicabut (HTTP $code)" }
        }
    }
    else {
        $others = @($tokenList | ForEach-Object { $_.id })
        if ($others.Count -gt 0) {
            Write-Info 'Untuk mencabut token lama (mis. yang pernah bocor di chat):'
            Write-Info ("  vms-git-auth -RevokeOld " + ($others -join ','))
        }
    }
}

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
