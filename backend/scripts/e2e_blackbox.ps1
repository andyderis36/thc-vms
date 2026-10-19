#Requires -Version 5.1
<#
  e2e_blackbox.ps1 - FULL blackbox RBAC E2E terhadap dev stack THC-VMS yang SEDANG BERJALAN.
  PS 5.1-compatible (tanpa operator ternary/??, hanya .NET BCL).
  Jalankan:  powershell -NoProfile -ExecutionPolicy Bypass -File backend\scripts\e2e_blackbox.ps1

  Kontrak SSOT : docs/4. openapi.yaml + literal dari backend/internal/domain/errors.go
                 dan backend/internal/usecase/{visit,gate,superadmin}/.
  Semua kasus negatif menguji envelope {success:false,error:{code,message}} DAN pesan Bahasa Indonesia.

  Kredensial  : literal seed docs/5. LOCAL_DEV.md. Semua akun dicoba, TIDAK ADA email karangan.
  Branch      : dipetakan DINAMIS dari /auth/me -> location_id. TIDAK PERNAH hardcode UUID cabang.

  Transport   : satu System.Net.Http.HttpClient dipakai ulang untuk SELURUH request (login,
                JSON, multipart). Ini menghindari socket/DNS churn dari Invoke-WebRequest per-call
                dan membuat perilakunya identik di PS 5.1 maupun PS 7.

  Pembersihan : HANYA lewat ID PERSIS yang dibuat skrip ini (CreatedVisits / CreatedSecUsers /
                CreatedUsers / CreatedLocations). TIDAK PERNAH lewat filter/pencarian.
                Verifikasi sisa dilakukan dengan GET per-ID (harus 404) - API TIDAK mengimplementasi
                ?search=, jadi verifikasi berbasis search akan selalu salah (over-report).
  Baris uji   : selalu diberi prefix "[E2E-BB]".
#>

[CmdletBinding()]
param(
  [string]$BaseUrl    = 'http://127.0.0.1:8080/api/v1',   # 127.0.0.1, bukan localhost (hindari ::1)
  [string]$Password   = '',   # TIDAK di-hardcode: diisi runtime dari docs / env / argumen
  [string]$FixtureDir = "$env:TEMP\e2e-bb"
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Net.Http

# ───────────────────────── state ─────────────────────────
$script:Results          = New-Object System.Collections.ArrayList
$script:CreatedVisits    = New-Object System.Collections.ArrayList
$script:CreatedSecUsers  = New-Object System.Collections.ArrayList
$script:CreatedUsers     = New-Object System.Collections.ArrayList
$script:CreatedLocations = New-Object System.Collections.ArrayList
$script:Tokens = @{}
$script:Me     = @{}
$TAG = '[E2E-BB]'

$script:Http = New-Object System.Net.Http.HttpClient
$script:Http.Timeout = [TimeSpan]::FromSeconds(90)
$script:Http.DefaultRequestHeaders.Add('Accept', 'application/json')

# ───────────────────────── kredensial runtime ─────────────────────────
# Password seed SENGAJA tidak tertanam di skrip ini. Urutan sumber:
#   1) argumen  -Password <nilai>
#   2) env      THCVMS_E2E_PASSWORD
#   3) dokumen  docs\5. LOCAL_DEV.md
# Tidak ada nilai default yang dibakar di dalam file.
if (-not $Password) {
  $Password = [string]$env:THCVMS_E2E_PASSWORD
}
if (-not $Password) {
  $docPath = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'docs\5. LOCAL_DEV.md'
  if (Test-Path -LiteralPath $docPath) {
    $docLines = @(Get-Content -LiteralPath $docPath -ErrorAction SilentlyContinue)
    foreach ($ln in $docLines) {
      $m = [regex]::Match($ln, '(?i)password\s+seragam.*?`([^`]{6,})`')
      if ($m.Success) { $Password = $m.Groups[1].Value; break }
    }
    if (-not $Password) {
      foreach ($ln in $docLines) {
        $m = [regex]::Match($ln, 'superadmin@thc\.net\.id`\s*\|\s*`([^`]{6,})`')
        if ($m.Success) { $Password = $m.Groups[1].Value; break }
      }
    }
  }
}
if (-not $Password) {
  throw 'Password seed tidak ditemukan. Beri -Password <nilai>, set env THCVMS_E2E_PASSWORD, atau pastikan docs\5. LOCAL_DEV.md tersedia.'
}
Write-Host ("  kredensial runtime: password diambil dari " + $(if ($env:THCVMS_E2E_PASSWORD) { 'env THCVMS_E2E_PASSWORD' } else { 'docs\5. LOCAL_DEV.md' }))

# ───────────────────────── transport ─────────────────────────
function New-Resp {
  param([int]$Status, [string]$Content)
  $obj = $null
  if (-not [string]::IsNullOrWhiteSpace($Content)) { try { $obj = ConvertFrom-Json -InputObject $Content } catch { $obj = $null } }
  return [pscustomobject]@{ Status = $Status; Body = $Content; Json = $obj }
}

# Retry lapis transport (http<0 = connection/DNS) supaya satu hiccup jaringan
# tidak mengaburkan verdict RBAC yang sebenarnya diuji.
function Send-Once {
  param([string]$Method, [string]$Url, [string]$Token, [string]$Json, $Multipart)
  $req = New-Object System.Net.Http.HttpRequestMessage(
    [System.Net.Http.HttpMethod]::new($Method), $Url)
  if ($Token) { $req.Headers.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', $Token) }
  # CATATAN: parameter bertipe [string] akan meng-coerce $null menjadi ''.
  # Karena itu body harus dicek dengan IsNullOrEmpty, BUKAN ($null -ne $Json),
  # kalau tidak setiap GET/DELETE akan membawa body kosong dan HttpClient menolak
  # dengan "Cannot send a content-body with this verb-type."
  if ($null -ne $Multipart) { $req.Content = $Multipart }
  elseif (-not [string]::IsNullOrEmpty($Json)) {
    $req.Content = New-Object System.Net.Http.StringContent($Json, [Text.Encoding]::UTF8, 'application/json')
  }
  try {
    $resp = $script:Http.SendAsync($req).GetAwaiter().GetResult()
    $body = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    return (New-Resp ([int]$resp.StatusCode) $body)
  } finally { $req.Dispose() }
}

function Invoke-Api {
  param(
    [Parameter(Mandatory)][string]$Method,
    [Parameter(Mandatory)][string]$Path,
    [string]$Token = '',
    $Body = $null
  )
  $json = $null
  if ($null -ne $Body) { $json = (ConvertTo-Json -InputObject $Body -Depth 12 -Compress) }
  $url = $BaseUrl + $Path
  for ($try = 1; $try -le 3; $try++) {
    $r = $null
    try { $r = Send-Once -Method $Method -Url $url -Token $Token -Json $json -Multipart $null }
    catch { $r = (New-Resp -1 ([string]$_.Exception.Message)) }
    if ($r.Status -gt 0) { return $r }
    Start-Sleep -Milliseconds 700
  }
  return (New-Resp -1 'transport-failed-after-3-retries')
}

function Upload-File {
  param([string]$Token, [string]$FilePath, [string]$Category, [string]$OwnerId = '')
  $bytes = [IO.File]::ReadAllBytes($FilePath)
  $form = New-Object System.Net.Http.MultipartFormDataContent
  $fc = New-Object System.Net.Http.ByteArrayContent(, $bytes)
  # MIME WAJIB sesuai ekstensi. Server menolak content-type generik:
  # 'application/octet-stream' -> 400 STORAGE_REJECTED (dibuktikan live).
  $ext  = ([IO.Path]::GetExtension($FilePath)).ToLowerInvariant()
  $mime = 'application/octet-stream'
  if ($ext -eq '.pdf') { $mime = 'application/pdf' }
  elseif ($ext -eq '.png') { $mime = 'image/png' }
  elseif ($ext -eq '.jpg' -or $ext -eq '.jpeg') { $mime = 'image/jpeg' }
  $fc.Headers.ContentType = New-Object System.Net.Http.Headers.MediaTypeHeaderValue($mime)
  $form.Add($fc, 'file', (Split-Path $FilePath -Leaf))
  $form.Add((New-Object System.Net.Http.StringContent($Category)), 'category')
  if ($OwnerId) { $form.Add((New-Object System.Net.Http.StringContent($OwnerId)), 'owner_id') }
  try {
    $r = Send-Once -Method 'POST' -Url "$BaseUrl/uploads" -Token $Token -Json $null -Multipart $form
    return $r
  } catch {
    return (New-Resp -1 ([string]$_.Exception.Message))
  } finally { $form.Dispose() }
}

function Get-ErrMessage { param($Resp) if ($Resp.Json -and $Resp.Json.error) { return [string]$Resp.Json.error.message } return '' }
function Get-ErrCode    { param($Resp) if ($Resp.Json -and $Resp.Json.error) { return [string]$Resp.Json.error.code }    return '' }

# ───────────────────────── assertions ─────────────────────────
function Add-R {
  param([string]$Id, [string]$Pri, [string]$Desc, [bool]$Ok, [string]$Expect, [string]$Actual, [string]$Evidence)
  [void]$script:Results.Add([pscustomobject]@{
    Id = $Id; Pri = $Pri; Desc = $Desc; Ok = $Ok; Expect = $Expect; Actual = $Actual; Evidence = $Evidence
  })
}

function Check {
  param(
    [Parameter(Mandatory)][string]$Id,
    [Parameter(Mandatory)][ValidateSet('P0','P1')][string]$Pri,
    [Parameter(Mandatory)][string]$Desc,
    [Parameter(Mandatory)][int]$ExpectStatus,
    [Parameter(Mandatory)]$Resp,
    [string]$ExpectMsg = '',
    [switch]$ExpectEnvelopeFail,
    [switch]$ExpectEmptyBody,   # 204 No Content memang tidak punya body JSON
    [string]$Code = ''
  )
  $fails = New-Object System.Collections.ArrayList
  if ($Resp.Status -ne $ExpectStatus) { [void]$fails.Add("status $($Resp.Status) != $ExpectStatus") }
  if ($ExpectEmptyBody) {
    if (-not [string]::IsNullOrWhiteSpace($Resp.Body)) {
      [void]$fails.Add("body 204 harus kosong, diterima: $($Resp.Body)")
    }
  } elseif ($ExpectEnvelopeFail) {
    if (-not $Resp.Json) { [void]$fails.Add('body bukan JSON') }
    elseif ($Resp.Json.success -ne $false) { [void]$fails.Add('success != false') }
    elseif (-not $Resp.Json.error) { [void]$fails.Add('field error hilang') }
    elseif ($ExpectMsg -and (Get-ErrMessage $Resp) -ne $ExpectMsg) {
      [void]$fails.Add("pesan '$(Get-ErrMessage $Resp)' != '$ExpectMsg'")
    }
  } else {
    if ($ExpectStatus -eq 204 -or [string]::IsNullOrWhiteSpace($Resp.Body)) {
      # 204 No Content: body kosong itu BENAR (dibuktikan live: DELETE balas 204 dgn body '').
    } elseif (-not $Resp.Json) { [void]$fails.Add('body bukan JSON') }
    elseif ($Resp.Json.success -ne $true) { [void]$fails.Add('success != true') }
  }
  if ($Code -and (Get-ErrCode $Resp) -ne $Code) { [void]$fails.Add("code '$(Get-ErrCode $Resp)' != '$Code'") }
  $ev = [string]$Resp.Body; if ($ev.Length -gt 220) { $ev = $ev.Substring(0, 220) + '...' }
  Add-R $Id $Pri $Desc ($fails.Count -eq 0) "$ExpectStatus $ExpectMsg" `
        "$($Resp.Status) $(Get-ErrCode $Resp) $(Get-ErrMessage $Resp)" $ev
  return ($fails.Count -eq 0)
}

function Check-Pre {
  # Pre-kondisi gagal (mis. create ditolak) -> dicatat sebagai FAIL, bukan crash seluruh run.
  param([string]$Id, [string]$Pri, [string]$Desc, $Obj)
  if ($null -eq $Obj) {
    Add-R $Id $Pri "$Desc [PREKONDISI]" $false 'visit harus terbentuk' 'null (create gagal)' 'precondition'
    return $false
  }
  return $true
}

# ───────────────────────── login (sekali per akun, token dipakai ulang) ─────────────────────────
function Login {
  param([string]$Key, [string]$Email)
  if ($script:Tokens.ContainsKey($Key)) { return $script:Tokens[$Key] }
  Start-Sleep -Seconds 3   # jeda rate-limit login
  $r = Invoke-Api -Method POST -Path '/auth/login' -Body (@{ email = $Email; password = $Password })
  if ($r.Status -ne 200 -or -not $r.Json.data.token) {
    throw "LOGIN GAGAL $Email => $($r.Status) $($r.Body)"
  }
  $script:Tokens[$Key] = [string]$r.Json.data.token
  return $script:Tokens[$Key]
}
function Me {
  param([string]$Key)
  if ($script:Me.ContainsKey($Key)) { return $script:Me[$Key] }
  $script:Me[$Key] = (Invoke-Api -Method GET -Path '/auth/me' -Token $script:Tokens[$Key]).Json.data
  return $script:Me[$Key]
}

# ───────────────────────── domain builder ─────────────────────────
function New-Visitor {
  param([int]$N = 1, [string]$VendorId = '', [string]$VendorName = '', [string]$Photo = '', [string]$IdCard = '')
  $v = @{
    name = "$TAG Teknisi $N"
    id_number = ('3578010200000{0:d3}' -f $N)
    phone = '081200000001'
  }
  if ($VendorId)   { $v['vendor_id'] = $VendorId }
  if ($VendorName) { $v['vendor_name'] = $VendorName }
  if ($Photo)      { $v['photo_url'] = $Photo }
  if ($IdCard)     { $v['id_card_photo_url'] = $IdCard }
  return $v
}
function New-VisitBody {
  param(
    [string]$LocationId, [string[]]$PurposeIds,
    [int]$StartOffsetMin = 30, [int]$EndOffsetMin = 180,
    [object[]]$Visitors = $null, [string]$Notes = "$TAG blackbox", [bool]$Nda = $true
  )
  $start = (Get-Date).ToUniversalTime().AddMinutes($StartOffsetMin).ToString("yyyy-MM-ddTHH:mm:ss'Z'")
  $end   = (Get-Date).ToUniversalTime().AddMinutes($EndOffsetMin).ToString("yyyy-MM-ddTHH:mm:ss'Z'")
  if ($null -eq $Visitors) { $Visitors = @((New-Visitor -N 1)) }
  return @{
    location_id = $LocationId; purpose_ids = $PurposeIds
    start_date = $start; end_date = $end; is_multi_day = $false
    is_nda_accepted = $Nda; notes = $Notes; visitors = $Visitors
  }
}
function Track-Visit    { param([string]$Id) if ($Id) { [void]$script:CreatedVisits.Add($Id) } }
function Track-SecUser  { param([string]$Id) if ($Id) { [void]$script:CreatedSecUsers.Add($Id) } }
function Track-User     { param([string]$Id) if ($Id) { [void]$script:CreatedUsers.Add($Id) } }
function Track-Location { param([string]$Id) if ($Id) { [void]$script:CreatedLocations.Add($Id) } }

# ───────────────────────── jaring pengaman (WAJIB) ─────────────────────────
# $ErrorActionPreference='Stop' -> error tak terduga menghentikan skrip. Tanpa jaring
# ini, baris uji bisa TERTINGGAL di DB. Trap ini selalu menghapus HANYA ID PERSIS
# yang skrip ini buat, lalu keluar dengan kode 2 (bukan 0/1) agar jelas "crash".
trap {
  $msg = [string]$_
  Write-Host ''
  Write-Host "!! ERROR TAK TERDUGA: $msg" -ForegroundColor Red
  Write-Host "!! Darurat: hapus sisa ID yang dibuat skrip ini (ID PERSIS, tanpa filter)..." -ForegroundColor Yellow
  $tok = ''
  if ($script:Tokens.ContainsKey('SA')) { $tok = [string]$script:Tokens['SA'] }
  if (-not $tok) {
    $lr = Invoke-Api -Method POST -Path '/auth/login' -Body (@{ email = 'superadmin@thc.net.id'; password = $Password })
    if ($lr.Status -eq 200 -and $lr.Json -and $lr.Json.data -and $lr.Json.data.token) { $tok = [string]$lr.Json.data.token }
  }
  if ($tok) {
    foreach ($id in @($script:CreatedVisits))    { [void](Invoke-Api -Method DELETE -Path "/visits/$id" -Token $tok) }
    foreach ($id in @($script:CreatedSecUsers))  { [void](Invoke-Api -Method DELETE -Path "/users/security/$id" -Token $tok) }
    foreach ($id in @($script:CreatedUsers))     { [void](Invoke-Api -Method DELETE -Path "/users/$id" -Token $tok) }
    foreach ($id in @($script:CreatedLocations)) { [void](Invoke-Api -Method DELETE -Path "/locations/$id" -Token $tok) }
    Write-Host '!! Penghapusan darurat selesai.' -ForegroundColor Yellow
  } else {
    Write-Host '!! TIDAK bisa login superadmin. Hapus manual ID di bawah ini:' -ForegroundColor Red
    Write-Host ('   kunjungan: ' + ($script:CreatedVisits    -join ', '))
    Write-Host ('   pengawas : ' + ($script:CreatedSecUsers  -join ', '))
    Write-Host ('   user     : ' + ($script:CreatedUsers     -join ', '))
    Write-Host ('   lokasi   : ' + ($script:CreatedLocations -join ', '))
  }
  try { $script:Http.Dispose() } catch { }
  exit 2
}

# ───────────────────────── fixtures upload ─────────────────────────
function New-Fixtures {
  if (-not (Test-Path $FixtureDir)) { New-Item -ItemType Directory -Force -Path $FixtureDir | Out-Null }
  $png = [byte[]](0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,0x00,0x00,0x00,0x0D,0x49,0x48,0x44,0x52,
                 0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,0x08,0x06,0x00,0x00,0x00,0x1F,0x15,0xC4,0x89,
                 0x00,0x00,0x00,0x0A,0x49,0x44,0x41,0x54,0x78,0x9C,0x63,0x00,0x01,0x00,0x00,0x05,0x00,
                 0x01,0x0D,0x0A,0x2D,0xB4,0x00,0x00,0x00,0x00,0x49,0x45,0x4E,0x44,0xAE,0x42,0x60,0x82)
  [IO.File]::WriteAllBytes("$FixtureDir\ktp.png",    $png)
  [IO.File]::WriteAllBytes("$FixtureDir\selfie.jpg", $png)
  # Server HANYA memverifikasi Content-Type yang dideklarasikan (tidak men-decode
  # byte file), jadi PNG yang disamarkan .jpg tetap lolos 201 - tetapi label
  # "JPEG asli" jadi tidak jujur. Tulis JPEG sungguhan agar fixture Matches test.
  $jpegOk = $false
  try {
    Add-Type -AssemblyName System.Drawing
    $bmp = New-Object System.Drawing.Bitmap 2, 2
    $bmp.SetPixel(0, 0, [System.Drawing.Color]::FromArgb(30, 58, 138))
    $bmp.SetPixel(1, 1, [System.Drawing.Color]::White)
    $bmp.Save("$FixtureDir\selfie.jpg", [System.Drawing.Imaging.ImageFormat]::Jpeg)
    $bmp.Dispose()
    $jpegOk = $true
  } catch {
    if (-not (Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue -PassThru)) {
      # Fallback tanpa System.Drawing: JPEG 1x1 grayscale baseline yang valid.
      [IO.File]::WriteAllBytes("$FixtureDir\selfie.jpg", [Convert]::FromBase64String(
        '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=='))
      $jpegOk = $true
    }
  }
  $magic = [IO.File]::ReadAllBytes("$FixtureDir\selfie.jpg")[0..2]
  if ($jpegOk -and $magic[0] -eq 0xFF -and $magic[1] -eq 0xD8 -and $magic[2] -eq 0xFF) {
    Write-Host "  fixture selfie.jpg = JPEG asli (magic FFD8FF, $((Get-Item "$FixtureDir\selfie.jpg").Length) byte)"
  } else {
    Write-Host "  ! selfie.jpg TIDAK ber-magic JPEG - test I-04 hanya menguji Content-Type, bukan isi file" -ForegroundColor Yellow
  }
  $pdf = "%PDF-1.4`n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj`n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj`n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj`ntrailer<</Root 1 0 R>>`n%%EOF"
  [IO.File]::WriteAllBytes("$FixtureDir\spk.pdf", [Text.Encoding]::ASCII.GetBytes($pdf))
  $big = New-Object byte[] (6 * 1024 * 1024); $png.CopyTo($big, 0)
  [IO.File]::WriteAllBytes("$FixtureDir\big.png", $big)
  $exe = New-Object byte[] 2048; $exe[0] = 0x4D; $exe[1] = 0x5A
  [IO.File]::WriteAllBytes("$FixtureDir\evil.exe", $exe)
}

# ═════════════════════════ PREFLIGHT ═════════════════════════
Write-Host "`n=== PREFLIGHT ===" -ForegroundColor Cyan
$h = Invoke-Api -Method GET -Path '/health'
if ($h.Status -ne 200 -or $h.Json.data.status -ne 'healthy') { throw "PREFLIGHT GAGAL /health => $($h.Status) $($h.Body)" }
[void](Check 'PRE-01' 'P0' 'GET /health -> healthy, envelope {success,data}' 200 $h)
Write-Host ("  health uptime=" + $h.Json.data.uptime)

# Kredensial: hanya email seed yang nyata. Login satu kali per akun, token dipakai ulang.
$ACCOUNTS = [ordered]@{
  sa   = 'superadmin@thc.net.id'
  adm1 = 'admin1@thc.com'
  adm2 = 'admin2@thc.com'
  adm3 = 'admin3@thc.com'
  adm4 = 'admin4@thc.com'
  adm5 = 'admin5@thc.com'
  sec1 = 'security1a@thc.com'
  sec2 = 'security2a@thc.com'
  vendor1 = 'vendor1a@thc.com'
}
foreach ($k in $ACCOUNTS.Keys) { [void](Login $k $ACCOUNTS[$k]) }
Write-Host "  login OK untuk $($ACCOUNTS.Count) akun seed"

# Pemetaan cabang DINAMIS dari /auth/me - tidak ada UUID cabang yang di-hardcode.
$meList = @()
foreach ($k in $ACCOUNTS.Keys) {
  $m = Me $k
  $meList += [pscustomobject]@{ Key = $k; Email = $ACCOUNTS[$k]; Role = [string]$m.role; LocationId = [string]$m.location_id; LocationName = [string]$m.location_name }
}
$meList | ForEach-Object { Write-Host ("  {0,-6} {1,-24} {2,-12} {3}" -f $_.Key, $_.Email, $_.Role, $_.LocationId) }

$LOC1 = (Me 'adm1').location_id
$LOC2 = (Me 'adm2').location_id
$SECID2 = [string](Me 'sec2').id
$VENDORID1 = [string](Me 'vendor1').id
$UUID0 = '00000000-0000-0000-0000-000000000000'
$UNKNOWN_UUID = '11111111-2222-3333-4444-555555555555'
$UNIQ_LOCS = @($meList | Where-Object { $_.LocationId -ne '' } | Select-Object -ExpandProperty LocationId -Unique)

$PURP = (((Invoke-Api -Method GET -Path '/purposes' -Token $script:Tokens['sa']).Json.data |
          Where-Object { $_.name -like 'Splicing*' } | Select-Object -First 1).id)
$VDA  = (((Invoke-Api -Method GET -Path '/vendors'  -Token $script:Tokens['sa']).Json.data |
          Where-Object { $_.name -like '*Lintas*' } | Select-Object -First 1).id)
if (-not $LOC1 -or -not $LOC2 -or -not $PURP -or -not $VDA -or $LOC1 -eq $LOC2) {
  throw "PREFLIGHT GAGAL: master data/cakupan cabang tidak lengkap (LOC1=$LOC1 LOC2=$LOC2 PURP=$PURP VDA=$VDA)"
}
Add-R 'PRE-02' 'P0' 'Pemetaan cabang dinamis via /auth/me (5 lokasi unik, tanpa hardcode UUID)' `
  ($UNIQ_LOCS.Count -ge 5) '>=5 lokasi unik dari 5 admin' "$($UNIQ_LOCS.Count) lokasi unik" `
  ($meList | ForEach-Object { "$($_.Key)=$($_.LocationId)" }) -join ' ; '
New-Fixtures
Write-Host "  cabang1(adm1/sec1)=$LOC1  cabang2(adm2/sec2)=$LOC2"
Write-Host "  purpose=$PURP  vendorA=$VDA"

# Baseline: jumlah baris sebelum suite (dipakai pembanding laporan, BUKAN target hapus).
$baseList = (Invoke-Api -Method GET -Path '/visits?limit=1' -Token $script:Tokens['sa'])
$BASELINE = [int]$baseList.Json.data.total
Write-Host "  baseline total kunjungan = $BASELINE"

$SA   = $script:Tokens['sa']
$ADM1 = $script:Tokens['adm1']
$ADM2 = $script:Tokens['adm2']
$SEC1 = $script:Tokens['sec1']
$SEC2 = $script:Tokens['sec2']
$VENDOR1 = $script:Tokens['vendor1']

function AdminFor { param([string]$Loc) if ($Loc -eq $LOC1) { return $ADM1 } else { return $ADM2 } }
function New-Approvable {
  param([string]$Loc, [int]$S = 30, [int]$E = 180)
  $r = Invoke-Api -Method POST -Path '/visits' -Token $VENDOR1 -Body (New-VisitBody -LocationId $Loc -PurposeIds @($PURP) -StartOffsetMin $S -EndOffsetMin $E)
  if ($r.Status -ne 201 -or -not $r.Json.data.id) { return $null }
  Track-Visit ([string]$r.Json.data.id)
  return $r.Json.data
}
function New-Approved {
  param([string]$Loc, [int]$S = 30, [int]$E = 180)
  $v = New-Approvable -Loc $Loc -S $S -E $E
  if ($null -eq $v) { return $null }
  $a = Invoke-Api -Method POST -Path "/visits/$($v.id)/approve" -Token (AdminFor $Loc) -Body @{ notes = "$TAG disetujui" }
  if ($a.Status -ne 200) { return $null }
  return $v
}

# ═════════════════════════ A. AUTH (P0) ═════════════════════════
Write-Host "`n=== A. AUTH ===" -ForegroundColor Cyan
$roles = @((Me 'sa').role, (Me 'adm1').role, (Me 'sec1').role, (Me 'vendor1').role) -join '/'
Add-R 'A-01' 'P0' 'Login 4 role (super_admin/admin/security/vendor) -> 200, token dipakai ulang' `
  ($roles -eq 'super_admin/admin/security/vendor') 'super_admin/admin/security/vendor' $roles `
  '9 akun seed login 200 (superadmin, admin1-5, security1a/2a, vendor1a)'
[void](Check 'A-02' 'P0' 'Login password salah -> 401 INVALID_CREDENTIALS (pesan ID)' 401 `
  (Invoke-Api -Method POST -Path '/auth/login' -Body (@{ email = 'admin1@thc.com'; password = 'Password123!X' })) `
  'Kredensial tidak valid' -ExpectEnvelopeFail -Code 'INVALID_CREDENTIALS')
[void](Check 'A-03' 'P0' 'Login email tak dikenal -> 401 (tidak bocor keberadaan akun)' 401 `
  (Invoke-Api -Method POST -Path '/auth/login' -Body (@{ email = 'tidak-ada@thc.com'; password = 'Password123!' })) `
  'Kredensial tidak valid' -ExpectEnvelopeFail -Code 'INVALID_CREDENTIALS')
[void](Check 'A-04' 'P0' 'Login field kosong -> 400 VALIDATION_ERROR' 400 `
  (Invoke-Api -Method POST -Path '/auth/login' -Body (@{ email = ''; password = '' })) `
  'Email dan password wajib diisi.' -ExpectEnvelopeFail -Code 'VALIDATION_ERROR')
[void](Check 'A-05' 'P0' 'GET /visits tanpa token -> 401 UNAUTHORIZED' 401 (Invoke-Api -Method GET -Path '/visits') `
  'Token tidak valid atau kedaluwarsa.' -ExpectEnvelopeFail -Code 'UNAUTHORIZED')
[void](Check 'A-06' 'P0' 'GET /visits dengan token palsu -> 401' 401 `
  (Invoke-Api -Method GET -Path '/visits' -Token 'eyJhbGciOiJIUzI1NiJ9.bogus.sig') `
  'Token tidak valid atau kedaluwarsa.' -ExpectEnvelopeFail)
$meR = Invoke-Api -Method GET -Path '/auth/me' -Token $ADM1
[void](Check 'A-07' 'P0' 'GET /auth/me admin cabang -> 200' 200 $meR)
$meAll = @()
foreach ($k in $ACCOUNTS.Keys) { $r = Invoke-Api -Method GET -Path '/auth/me' -Token $script:Tokens[$k]; $meAll += $r.Status }
Add-R 'A-08' 'P0' '/auth/me 200 untuk 9/9 akun & role sesuai' `
  (($meAll | Where-Object { $_ -ne 200 }).Count -eq 0) '9x200' "$(@($meAll | Where-Object { $_ -eq 200 }).Count)x200" $roles
# Dihitung eksplisit ke variabel (dibungkus @()) supaya tidak ambigu saat dilapor:
# A-09 sempat FAIL padahal data /auth/me benar, karena hasil pipeline kosong tidak
# pernah dibungkus array sehingga .Count-nya tidak bisa diandalkan.
$admRows = @($meList | Where-Object { $_.Key -like 'adm*' })
$badRole = @($admRows | Where-Object { [string]$_.Role -ne 'admin' }).Count
$noLoc   = @($admRows | Where-Object { [string]$_.LocationId -eq '' }).Count
Add-R 'A-09' 'P0' 'admin1..admin5 semua role=admin & punya location_id' `
  (($admRows.Count -eq 5) -and ($badRole -eq 0) -and ($noLoc -eq 0)) `
  '5 admin: role=admin & location_id terisi' `
  "adm=$($admRows.Count) badRole=$badRole noLoc=$noLoc" `
  (($admRows | ForEach-Object { "$($_.Key)=$($_.Role)/$($_.LocationId)" }) -join ' ; ')

# ═════════════════════════ B. CREATE VISIT (P0) ═════════════════════════
Write-Host "`n=== B. CREATE VISIT ===" -ForegroundColor Cyan
$r = Invoke-Api -Method POST -Path '/visits' -Token $VENDOR1 -Body (New-VisitBody -LocationId $LOC1 -PurposeIds @($PURP))
$vVendorOwn = $null
if ($r.Status -eq 201 -and $r.Json.data.id) { Track-Visit ([string]$r.Json.data.id); $vVendorOwn = $r.Json.data }
[void](Check 'B-01' 'P0' 'vendor membuat kunjungan -> 201' 201 $r)
if ($vVendorOwn) {
  $vst = [string]$vVendorOwn.visit_id
  Add-R 'B-02' 'P0' 'visit_id server-generated format VST-<10 digit>' ($vst -match '^VST-\d{10}$') '^VST-\d{10}$' $vst $vst
  Add-R 'B-03' 'P0' 'status awal = requested' ([string]$vVendorOwn.status -eq 'requested') 'requested' ([string]$vVendorOwn.status) ([string]$vVendorOwn.status)
  Add-R 'B-04' 'P0' 'id (UUID) != visit_id (VST-kode) keduanya ada' `
    (([string]$vVendorOwn.id -ne '') -and ($vst -ne '')) 'id & visit_id keduanya ada' "id=$($vVendorOwn.id) visit_id=$vst" "id=$($vVendorOwn.id)"
}
$r = Invoke-Api -Method POST -Path '/visits' -Token $ADM1 -Body (New-VisitBody -LocationId $LOC1 -PurposeIds @($PURP))
if ($r.Status -eq 201) { Track-Visit ([string]$r.Json.data.id) }
[void](Check 'B-05' 'P0' 'Admin cabang membuat di cabang SENDIRI -> 201' 201 $r)
[void](Check 'B-06' 'P0' 'Admin cabang membuat di cabang LAIN -> 403 FORBIDDEN_BRANCH' 403 `
  (Invoke-Api -Method POST -Path '/visits' -Token $ADM1 -Body (New-VisitBody -LocationId $LOC2 -PurposeIds @($PURP))) `
  'Tidak berhak mengelola kunjungan cabang lain' -ExpectEnvelopeFail -Code 'FORBIDDEN_BRANCH')
[void](Check 'B-07' 'P0' 'Security membuat kunjungan -> 403' 403 `
  (Invoke-Api -Method POST -Path '/visits' -Token $SEC1 -Body (New-VisitBody -LocationId $LOC1 -PurposeIds @($PURP))) `
  'Tidak berhak mengelola kunjungan cabang lain' -ExpectEnvelopeFail)

# Freshness probe: echo visitors[].photo_url + vendor_id (indikator binary baru).
$r = Invoke-Api -Method POST -Path '/visits' -Token $VENDOR1 -Body (New-VisitBody -LocationId $LOC1 -PurposeIds @($PURP) `
  -Visitors @((New-Visitor -N 1 -VendorId $VDA -VendorName "$TAG Manual Corp" `
    -Photo 'http://localhost:9000/thc-vms-bucket/id_card/pending/probe.jpg' `
    -IdCard 'http://localhost:9000/thc-vms-bucket/id_card/pending/probe_ktp.jpg')))
if ($r.Status -eq 201) { Track-Visit ([string]$r.Json.data.id) }
$okFresh = Check 'B-08' 'P0' 'Freshness probe: visitors[].vendor_id + photo_url + id_card_photo_url -> 201' 201 $r
if ($okFresh) {
  $vv = $r.Json.data.visitors[0]; $f = New-Object System.Collections.ArrayList
  if ([string]$vv.vendor_id -ne $VDA) { [void]$f.Add("vendor_id='$($vv.vendor_id)'") }
  if ([string]$vv.vendor_name -ne 'PT Lintas Fiber') { [void]$f.Add("vendor_name='$($vv.vendor_name)' (katalog harus menang)") }
  if ([string]$vv.photo_url -notlike 'http://localhost:9000/*') { [void]$f.Add("photo_url='$($vv.photo_url)'") }
  if ([string]$vv.id_card_photo_url -notlike 'http://localhost:9000/*') { [void]$f.Add("id_card_photo_url='$($vv.id_card_photo_url)'") }
  Add-R 'B-09' 'P0' 'Echo visitors[] utuh: vendor_id katalog + photo_url + id_card_photo_url (FRESH binary)' `
    ($f.Count -eq 0) 'echo utuh' $(if ($f.Count) { 'gagal: ' + ($f -join '; ') } else { 'utuh' }) ($vv | ConvertTo-Json -Compress)
}
$r = Invoke-Api -Method POST -Path '/visits' -Token $VENDOR1 -Body (New-VisitBody -LocationId $LOC1 -PurposeIds @($PURP) `
  -Visitors @((New-Visitor -N 1 -VendorName "$TAG PT Manual Corp")))
if ($r.Status -eq 201) { Track-Visit ([string]$r.Json.data.id) }
$ok = Check 'B-10' 'P0' 'Per-tech vendor_name manual saja -> 201' 201 $r
if ($ok) {
  $vn = [string]$r.Json.data.visitors[0].vendor_name
  Add-R 'B-11' 'P0' 'vendor_name manual dihormati saat vendor_id absen' `
    ($vn -eq "$TAG PT Manual Corp") "$TAG PT Manual Corp" $vn $vn
}
$r = Invoke-Api -Method POST -Path '/visits' -Token $VENDOR1 -Body (New-VisitBody -LocationId $LOC1 -PurposeIds @($PURP) -Visitors @((New-Visitor -N 1)))
if ($r.Status -eq 201) { Track-Visit ([string]$r.Json.data.id) }
$ok = Check 'B-12' 'P0' 'Per-tech tanpa vendor_id & vendor_name -> 201 (absen = null)' 201 $r
if ($ok) {
  $vv = $r.Json.data.visitors[0]
  Add-R 'B-13' 'P0' 'vendor_id & vendor_name null saat tidak diisi' `
    (($null -eq $vv.vendor_id) -and ($null -eq $vv.vendor_name)) 'null/null' "$($vv.vendor_id)/$($vv.vendor_name)" ($vv | ConvertTo-Json -Compress)
}
[void](Check 'B-14' 'P0' 'Per-tech vendor_id UUID tak dikenal -> 422' 422 `
  (Invoke-Api -Method POST -Path '/visits' -Token $VENDOR1 -Body (New-VisitBody -LocationId $LOC1 -PurposeIds @($PURP) -Visitors @((New-Visitor -N 1 -VendorId $UNKNOWN_UUID)))) `
  'Vendor tidak ditemukan atau tidak aktif.' -ExpectEnvelopeFail -Code 'VALIDATION_ERROR')
[void](Check 'B-15' 'P0' 'Per-tech vendor_id malformed -> 400' 400 `
  (Invoke-Api -Method POST -Path '/visits' -Token $VENDOR1 -Body (New-VisitBody -LocationId $LOC1 -PurposeIds @($PURP) -Visitors @((New-Visitor -N 1 -VendorId 'bukan-uuid')))) `
  'vendor_id pengunjung ke-1 tidak valid.' -ExpectEnvelopeFail -Code 'VALIDATION_ERROR')
$b = New-VisitBody -LocationId $LOC1 -PurposeIds @($PURP); $b['visitors'] = @()
[void](Check 'B-16' 'P0' 'visitors kosong -> 400' 400 (Invoke-Api -Method POST -Path '/visits' -Token $VENDOR1 -Body $b) `
  'Minimal satu pengunjung wajib didaftarkan.' -ExpectEnvelopeFail)
$b = New-VisitBody -LocationId $LOC1 -PurposeIds @(); $b['purpose_ids'] = @()
[void](Check 'B-17' 'P0' 'Tanpa purpose_ids -> 400' 400 (Invoke-Api -Method POST -Path '/visits' -Token $VENDOR1 -Body $b) `
  'Minimal satu tujuan kunjungan wajib dipilih atau ditulis.' -ExpectEnvelopeFail)
[void](Check 'B-18' 'P0' 'end_date <= start_date -> 422' 422 `
  (Invoke-Api -Method POST -Path '/visits' -Token $VENDOR1 -Body (New-VisitBody -LocationId $LOC1 -PurposeIds @($PURP) -StartOffsetMin 180 -EndOffsetMin 60)) `
  'Tanggal selesai harus setelah tanggal mulai.' -ExpectEnvelopeFail)
[void](Check 'B-19' 'P0' 'is_nda_accepted=false -> 422' 422 `
  (Invoke-Api -Method POST -Path '/visits' -Token $VENDOR1 -Body (New-VisitBody -LocationId $LOC1 -PurposeIds @($PURP) -Nda $false)) `
  'Persetujuan NDA wajib disetujui sebagai bentuk kepatuhan K3/SOP sebelum mengajukan kunjungan.' -ExpectEnvelopeFail)
$b = New-VisitBody -LocationId $LOC1 -PurposeIds @($PURP); $b['visitors'] = @((New-Visitor -N 1 -VendorName ('X' * 130)))
[void](Check 'B-20' 'P1' 'vendor_name manual > 120 karakter -> 400' 400 (Invoke-Api -Method POST -Path '/visits' -Token $VENDOR1 -Body $b) `
  'Nama perusahaan vendor pengunjung ke-1 maksimal 120 karakter.' -ExpectEnvelopeFail)
$b = New-VisitBody -LocationId $LOC1 -PurposeIds @($PURP)
$b['visitors'] = @(1..11 | ForEach-Object { New-Visitor -N $_ })
[void](Check 'B-21' 'P0' 'visitors > 10 orang -> 400 batas maksimal' 400 (Invoke-Api -Method POST -Path '/visits' -Token $VENDOR1 -Body $b) `
  'Jumlah pengunjung maksimal 10 orang.' -ExpectEnvelopeFail)
$b = New-VisitBody -LocationId $LOC1 -PurposeIds @($PURP)
$b['visitors'] = @((New-Visitor -N 1 -Photo 'javascript:alert(1)'))
[void](Check 'B-22' 'P1' 'photo_url skema berbahaya (javascript:) -> 422' 422 (Invoke-Api -Method POST -Path '/visits' -Token $VENDOR1 -Body $b) `
  'Tautan berkas tidak valid.' -ExpectEnvelopeFail)

# ═════════════════════════ C. SCOPING LIST/DETAIL (P0) ═════════════════════════
Write-Host "`n=== C. SCOPING LIST/DETAIL ===" -ForegroundColor Cyan
function Assert-Scope {
  param([string]$Id, [string]$Token, [string]$Label, [string]$LocationId, [string]$VendorId)
  $r = Invoke-Api -Method GET -Path '/visits?limit=100' -Token $Token
  if ($r.Status -ne 200) { Add-R $Id 'P0' "List $Label -> 200" $false '200' "$($r.Status)" $r.Body; return }
  $items = @($r.Json.data.items); $bad = @()
  if ($LocationId) { $bad += @($items | Where-Object { [string]$_.location.id -ne $LocationId } | ForEach-Object { $_.visit_id }) }
  if ($VendorId)      { $bad += @($items | Where-Object { [string]$_.vendor_user.id  -ne $VendorId      } | ForEach-Object { $_.visit_id }) }
  Add-R $Id 'P0' "List $Label -> hanya cakupan sendiri ($($items.Count) baris)" ($bad.Count -eq 0) `
    $(if ($LocationId) { "location=$LocationId" } else { "vendor_user=$VendorId" }) `
    $(if ($bad.Count) { "BOCOR $($bad.Count): $($bad -join ',')" } else { 'semua dalam cakupan' }) `
    "status=$($r.Status) total=$($r.Json.data.total) page=$($r.Json.data.page) limit=$($r.Json.data.limit)"
}
Assert-Scope 'C-01' $ADM1 'admin cabang1' $LOC1 ''
Assert-Scope 'C-02' $SEC1 'security cabang1' $LOC1 ''
Assert-Scope 'C-03' $ADM2 'admin cabang2' $LOC2 ''
Assert-Scope 'C-04' $VENDOR1 'vendor' $null $VENDORID1
$r = Invoke-Api -Method GET -Path "/visits?location_id=$LOC2&limit=100" -Token $SA
$bad = @(@($r.Json.data.items) | Where-Object { [string]$_.location.id -ne $LOC2 })
Add-R 'C-05' 'P0' 'Superadmin list ?location_id= -> lintas cabang tersaring' `
  (($r.Status -eq 200) -and ($bad.Count -eq 0)) '200 + semua match filter' "$($r.Status) / bocor=$($bad.Count)" `
  "status=$($r.Status) total=$($r.Json.data.total)"
$r = Invoke-Api -Method GET -Path '/visits?limit=100' -Token $SA
$uniq = @(@($r.Json.data.items) | ForEach-Object { $_.location.id } | Select-Object -Unique)
Add-R 'C-06' 'P0' 'Superadmin list tanpa filter -> lintas cabang (>=2 lokasi unik)' `
  (($r.Status -eq 200) -and ($uniq.Count -ge 2)) '>=2 lokasi unik' "$($uniq.Count) lokasi unik" "status=$($r.Status) total=$($r.Json.data.total)"

$vCross = New-Approvable -Loc $LOC2
if (Check-Pre 'C-07' 'P0' 'Visit cabang2 untuk uji silang' $vCross) {
  Write-Host ("  C-07 visit cabang2 = " + $vCross.visit_id)
  [void](Check 'C-08' 'P0' 'Detail kunjungan cabang lain oleh admin -> 403 (tidak bocor)' 403 `
    (Invoke-Api -Method GET -Path "/visits/$($vCross.id)" -Token $ADM1) `
    'Tidak berhak mengelola kunjungan cabang lain' -ExpectEnvelopeFail -Code 'FORBIDDEN_BRANCH')
  [void](Check 'C-09' 'P0' 'Detail kunjungan cabang lain oleh security -> 403' 403 `
    (Invoke-Api -Method GET -Path "/visits/$($vCross.id)" -Token $SEC1) `
    'Tidak berhak mengelola kunjungan cabang lain' -ExpectEnvelopeFail)
  [void](Check 'C-10' 'P0' 'Detail kunjungan oleh superadmin -> 200' 200 `
    (Invoke-Api -Method GET -Path "/visits/$($vCross.id)" -Token $SA))
  [void](Check 'C-11' 'P0' 'vendor melihat detail miliknya -> 200' 200 `
    (Invoke-Api -Method GET -Path "/visits/$($vCross.id)" -Token $VENDOR1))
  [void](Check 'C-12' 'P0' 'Detail juga menerima kode VST- (bukan hanya UUID) -> 200' 200 `
    (Invoke-Api -Method GET -Path "/visits/$($vCross.visit_id)" -Token $SA))
}
[void](Check 'C-13' 'P1' 'Detail UUID tak dikenal -> 404 NOT_FOUND' 404 `
  (Invoke-Api -Method GET -Path "/visits/$UUID0" -Token $SA) -ExpectEnvelopeFail -Code 'NOT_FOUND')

# ═════════════════════════ D. APPROVE / REJECT (P0) ═════════════════════════
Write-Host "`n=== D. APPROVE/REJECT ===" -ForegroundColor Cyan
$vApp = New-Approvable -Loc $LOC1
if (Check-Pre 'D-01' 'P0' 'Visit requested untuk approve' $vApp) {
  Write-Host ("  D-01 visit = " + $vApp.visit_id)
  [void](Check 'D-02' 'P0' 'Approve oleh admin cabang sendiri -> 200' 200 `
    (Invoke-Api -Method POST -Path "/visits/$($vApp.id)/approve" -Token $ADM1 -Body @{ notes = "$TAG disetujui" }))
  [void](Check 'D-03' 'P0' 'Double approve -> 409 INVALID_TRANSITION' 409 `
    (Invoke-Api -Method POST -Path "/visits/$($vApp.id)/approve" -Token $ADM1 -Body @{ notes = "$TAG kedua" }) `
    'Transisi status kunjungan tidak diizinkan.' -ExpectEnvelopeFail -Code 'INVALID_TRANSITION')
}
$vRej = New-Approvable -Loc $LOC1
if (Check-Pre 'D-04' 'P0' 'Visit requested untuk reject' $vRej) {
  Write-Host ("  D-04 visit = " + $vRej.visit_id)
  [void](Check 'D-05' 'P0' 'Reject oleh admin cabang sendiri (alasan sah) -> 200' 200 `
    (Invoke-Api -Method POST -Path "/visits/$($vRej.id)/reject" -Token $ADM1 -Body @{ reason = "$TAG alasan penolakan sah" }))
  [void](Check 'D-06' 'P0' 'Approve pada kunjungan rejected -> 409 INVALID_TRANSITION' 409 `
    (Invoke-Api -Method POST -Path "/visits/$($vRej.id)/approve" -Token $ADM1 -Body @{}) `
    'Transisi status kunjungan tidak diizinkan.' -ExpectEnvelopeFail)
}
$vRej2 = New-Approvable -Loc $LOC1
if (Check-Pre 'D-07' 'P0' 'Visit untuk reject reason pendek' $vRej2) {
  [void](Check 'D-08' 'P0' 'Reject alasan < 5 karakter -> 400' 400 `
    (Invoke-Api -Method POST -Path "/visits/$($vRej2.id)/reject" -Token $ADM1 -Body @{ reason = 'xx' }) `
    'Alasan penolakan minimal 5 karakter.' -ExpectEnvelopeFail)
  [void](Check 'D-09' 'P0' 'Reject tanpa alasan -> 400 (validasi min-length lebih dulu, bukan 422)' 400 `
    (Invoke-Api -Method POST -Path "/visits/$($vRej2.id)/reject" -Token $ADM1 -Body @{}) `
    'Alasan penolakan minimal 5 karakter.' -ExpectEnvelopeFail)
}
$vXA = New-Approvable -Loc $LOC2
if (Check-Pre 'D-10' 'P0' 'Visit cabang2 untuk uji cross-branch approve' $vXA) {
  Write-Host ("  D-10 visit = " + $vXA.visit_id)
  [void](Check 'D-11' 'P0' 'Approve lintas cabang oleh admin -> 403 FORBIDDEN_BRANCH' 403 `
    (Invoke-Api -Method POST -Path "/visits/$($vXA.id)/approve" -Token $ADM1 -Body @{ notes = "$TAG lintas" }) `
    'Tidak berhak mengelola kunjungan cabang lain' -ExpectEnvelopeFail -Code 'FORBIDDEN_BRANCH')
  [void](Check 'D-12' 'P0' 'Approve lintas cabang oleh superadmin -> 200 (cakupan global)' 200 `
    (Invoke-Api -Method POST -Path "/visits/$($vXA.id)/approve" -Token $SA -Body @{ notes = "$TAG superadmin" }))
}
$vP = New-Approvable -Loc $LOC1
if (Check-Pre 'D-13' 'P0' 'Visit untuk uji role non-approver' $vP) {
  [void](Check 'D-14' 'P0' 'Approve oleh vendor -> 403' 403 `
    (Invoke-Api -Method POST -Path "/visits/$($vP.id)/approve" -Token $VENDOR1 -Body @{}) `
    'Tidak berhak mengelola kunjungan cabang lain' -ExpectEnvelopeFail)
  [void](Check 'D-15' 'P0' 'Approve oleh security -> 403' 403 `
    (Invoke-Api -Method POST -Path "/visits/$($vP.id)/approve" -Token $SEC1 -Body @{}) `
    'Tidak berhak mengelola kunjungan cabang lain' -ExpectEnvelopeFail)
}

# ═════════════════════════ E. RESCHEDULE / CANCEL (P1) ═════════════════════════
Write-Host "`n=== E. RESCHEDULE/CANCEL ===" -ForegroundColor Cyan
$s1 = (Get-Date).ToUniversalTime().AddMinutes(240).ToString("yyyy-MM-ddTHH:mm:ss'Z'")
$e1 = (Get-Date).ToUniversalTime().AddMinutes(360).ToString("yyyy-MM-ddTHH:mm:ss'Z'")
$vRs = New-Approved -Loc $LOC1
if (Check-Pre 'E-01' 'P1' 'Visit untuk reschedule' $vRs) {
  Write-Host ("  E-01 visit = " + $vRs.visit_id)
  [void](Check 'E-02' 'P1' 'Reschedule oleh vendor pemilik -> 200' 200 `
    (Invoke-Api -Method POST -Path "/visits/$($vRs.id)/reschedule" -Token $VENDOR1 -Body @{ start_date = $s1; end_date = $e1; reason = "$TAG reschedule" }))
  [void](Check 'E-03' 'P1' 'Reschedule kedua kali -> 409 INVALID_TRANSITION' 409 `
    (Invoke-Api -Method POST -Path "/visits/$($vRs.id)/reschedule" -Token $ADM1 -Body @{ start_date = $s1; end_date = $e1; reason = "$TAG kedua" }) `
    'Transisi status kunjungan tidak diizinkan.' -ExpectEnvelopeFail)
}
$vRs2 = New-Approved -Loc $LOC1
if (Check-Pre 'E-04' 'P1' 'Visit untuk reschedule oleh security' $vRs2) {
  [void](Check 'E-05' 'P1' 'Reschedule oleh security -> 403' 403 `
    (Invoke-Api -Method POST -Path "/visits/$($vRs2.id)/reschedule" -Token $SEC1 -Body @{ start_date = $s1; end_date = $e1; reason = "$TAG security" }) `
    'Tidak berhak mengelola kunjungan cabang lain' -ExpectEnvelopeFail)
}
$vRs3 = New-Approvable -Loc $LOC1
if (Check-Pre 'E-06' 'P1' 'Visit untuk reschedule kosong' $vRs3) {
  [void](Check 'E-07' 'P1' 'Reschedule tanpa tanggal/alasan -> 400' 400 `
    (Invoke-Api -Method POST -Path "/visits/$($vRs3.id)/reschedule" -Token $VENDOR1 -Body @{ start_date = ''; end_date = ''; reason = '' }) `
    'Tanggal mulai, tanggal selesai, dan alasan penjadwalan ulang wajib diisi.' -ExpectEnvelopeFail)
}
$vRs4 = New-Approved -Loc $LOC1
if (Check-Pre 'E-08' 'P1' 'Visit untuk reschedule oleh admin' $vRs4) {
  [void](Check 'E-09' 'P1' 'Reschedule oleh admin cabang sendiri -> 200' 200 `
    (Invoke-Api -Method POST -Path "/visits/$($vRs4.id)/reschedule" -Token $ADM1 -Body @{ start_date = $s1; end_date = $e1; reason = "$TAG admin" }))
}
$vC = New-Approvable -Loc $LOC1
if (Check-Pre 'E-10' 'P1' 'Visit untuk cancel' $vC) {
  Write-Host ("  E-10 visit = " + $vC.visit_id)
  [void](Check 'E-11' 'P1' 'Cancel oleh vendor pemilik -> 200' 200 `
    (Invoke-Api -Method POST -Path "/visits/$($vC.id)/cancel" -Token $VENDOR1 -Body @{ reason = "$TAG batal" }))
}
$vC2 = New-Approvable -Loc $LOC1
if (Check-Pre 'E-12' 'P1' 'Visit untuk cancel oleh security' $vC2) {
  [void](Check 'E-13' 'P1' 'Cancel oleh security -> 403' 403 `
    (Invoke-Api -Method POST -Path "/visits/$($vC2.id)/cancel" -Token $SEC1 -Body @{ reason = "$TAG security" }) `
    'Tidak berhak mengelola kunjungan cabang lain' -ExpectEnvelopeFail)
}
$vC3 = New-Approvable -Loc $LOC1
if (Check-Pre 'E-14' 'P1' 'Visit untuk cancel oleh admin' $vC3) {
  [void](Check 'E-15' 'P1' 'Cancel oleh admin cabang sendiri -> 200' 200 `
    (Invoke-Api -Method POST -Path "/visits/$($vC3.id)/cancel" -Token $ADM1 -Body @{ reason = "$TAG admin batal" }))
}
$vC4 = New-Approvable -Loc $LOC2
if (Check-Pre 'E-16' 'P1' 'Visit cabang2 untuk cancel lintas cabang' $vC4) {
  [void](Check 'E-17' 'P1' 'Cancel lintas cabang oleh admin -> 403' 403 `
    (Invoke-Api -Method POST -Path "/visits/$($vC4.id)/cancel" -Token $ADM1 -Body @{ reason = "$TAG lintas" }) `
    'Tidak berhak mengelola kunjungan cabang lain' -ExpectEnvelopeFail)
}

# ═════════════════════════ F. DELETE VISIT (P0) ═════════════════════════
Write-Host "`n=== F. DELETE VISIT ===" -ForegroundColor Cyan
$vDel = New-Approvable -Loc $LOC1
if (Check-Pre 'F-01' 'P0' 'Visit untuk uji delete' $vDel) {
  Write-Host ("  F-01 visit = " + $vDel.visit_id)
  [void](Check 'F-02' 'P0' 'Delete oleh admin -> 403' 403 (Invoke-Api -Method DELETE -Path "/visits/$($vDel.id)" -Token $ADM1) `
    'Tidak berhak mengelola kunjungan cabang lain' -ExpectEnvelopeFail -Code 'FORBIDDEN_BRANCH')
  [void](Check 'F-03' 'P0' 'Delete oleh vendor -> 403' 403 (Invoke-Api -Method DELETE -Path "/visits/$($vDel.id)" -Token $VENDOR1) `
    'Tidak berhak mengelola kunjungan cabang lain' -ExpectEnvelopeFail)
  [void](Check 'F-04' 'P0' 'Delete oleh security -> 403' 403 (Invoke-Api -Method DELETE -Path "/visits/$($vDel.id)" -Token $SEC1) `
    'Tidak berhak mengelola kunjungan cabang lain' -ExpectEnvelopeFail -Code 'FORBIDDEN_BRANCH')
  # 204 No Content: body WAJIB kosong. Kalau Check Ongoing memaksa body JSON,
  # DELETE yang sah akan dilaporkan FAIL dan ID-nya tetap tercatat -> cleanup
  # mencoba DELETE lagi lalu kena 404 (CL-01 false positive).
  $okDel = Check 'F-05' 'P0' 'Delete oleh superadmin -> 204 (body kosong)' 204 `
    (Invoke-Api -Method DELETE -Path "/visits/$($vDel.id)" -Token $SA) -ExpectEmptyBody
  if ($okDel) { [void]$script:CreatedVisits.Remove([string]$vDel.id) }
  [void](Check 'F-06' 'P0' 'Setelah delete, detail -> 404' 404 (Invoke-Api -Method GET -Path "/visits/$($vDel.id)" -Token $SA) `
    -ExpectEnvelopeFail -Code 'NOT_FOUND')
}

# ═════════════════════════ G. CHECK-IN (P0) ═════════════════════════
Write-Host "`n=== G. CHECK-IN ===" -ForegroundColor Cyan
$vIn1 = New-Approved -Loc $LOC1 -S 30 -E 180
if (Check-Pre 'G-01' 'P0' 'Visit approved dalam jendela' $vIn1) {
  Write-Host ("  G-01 visit = " + $vIn1.visit_id)
  [void](Check 'G-02' 'P0' 'Check-in dalam jendela oleh SECURITY -> 200' 200 `
    (Invoke-Api -Method POST -Path "/visits/$($vIn1.id)/checkin" -Token $SEC1 -Body @{ badge_code = "$TAG badge1"; notes = "$TAG scan kamera" }))
  [void](Check 'G-03' 'P0' 'Double check-in -> 409 CONFLICT' 409 `
    (Invoke-Api -Method POST -Path "/visits/$($vIn1.id)/checkin" -Token $SEC1 -Body @{}) `
    'Kunjungan berstatus "visiting" tidak dapat di-check-in.' -ExpectEnvelopeFail -Code 'CONFLICT')
  [void](Check 'G-04' 'P0' 'Check-in oleh vendor -> 403' 403 `
    (Invoke-Api -Method POST -Path "/visits/$($vIn1.id)/checkin" -Token $VENDOR1 -Body @{}) `
    'Tidak berhak mengelola kunjungan cabang lain' -ExpectEnvelopeFail)
  [void](Check 'G-05' 'P0' 'Check-in oleh security cabang LAIN -> 403' 403 `
    (Invoke-Api -Method POST -Path "/visits/$($vIn1.id)/checkin" -Token $SEC2 -Body @{}) `
    'Tidak berhak mengelola kunjungan cabang lain' -ExpectEnvelopeFail)
  # QR == visit_id, tiket identik dengan yang dipakai check-in
  $rq = Invoke-Api -Method GET -Path "/visits/$($vIn1.id)/qr" -Token $VENDOR1
  $qrOk = $false; $qrD = ''
  if ($rq.Status -eq 200 -and $rq.Json.data) {
    $payload = [string]$rq.Json.data.qr_code_payload
    $qrOk = ($payload -eq [string]$vIn1.visit_id)
    $qrD = "visit_id=$($vIn1.visit_id) qr_code_payload=$payload"
  }
  Add-R 'G-06' 'P0' 'QR payload == visit_id (tiket identik dengan check-in)' `
    (($rq.Status -eq 200) -and $qrOk) 'qr_code_payload = visit_id' `
    $(if ($qrOk) { 'SAMA' } else { 'BEDA' }) "$($rq.Status) $qrD"
}
$vIn2 = New-Approved -Loc $LOC1 -S 30 -E 180
if (Check-Pre 'G-07' 'P0' 'Visit approved untuk dual-role admin' $vIn2) {
  Write-Host ("  G-07 visit = " + $vIn2.visit_id)
  [void](Check 'G-08' 'P0' 'Check-in dalam jendela oleh ADMIN CABANG (dual-role) -> 200' 200 `
    (Invoke-Api -Method POST -Path "/visits/$($vIn2.id)/checkin" -Token $ADM1 -Body @{ badge_code = "$TAG badge2" }))
}
# Jendela +/-2 jam
$vEarly = New-Approved -Loc $LOC1 -S 400 -E 560
if (Check-Pre 'G-09' 'P0' 'Visit approved 6h+ ke depan' $vEarly) {
  Write-Host ("  G-09 visit = " + $vEarly.visit_id)
  [void](Check 'G-10' 'P0' 'Check-in terlalu awal (> start-2j) -> 400 CHECKIN_WINDOW_EXCEEDED' 400 `
    (Invoke-Api -Method POST -Path "/visits/$($vEarly.id)/checkin" -Token $SEC1 -Body @{}) `
    'Kunjungan belum dibuka atau sudah melewati batas waktu toleransi.' -ExpectEnvelopeFail -Code 'CHECKIN_WINDOW_EXCEEDED')
}
$vLate = New-Approved -Loc $LOC1 -S -560 -E -400
if (Check-Pre 'G-11' 'P0' 'Visit approved 6h+ ke belakang' $vLate) {
  Write-Host ("  G-11 visit = " + $vLate.visit_id)
  [void](Check 'G-12' 'P0' 'Check-in terlalu akhir (< end+2j) -> 400 CHECKIN_WINDOW_EXCEEDED' 400 `
    (Invoke-Api -Method POST -Path "/visits/$($vLate.id)/checkin" -Token $SEC1 -Body @{}) `
    'Kunjungan belum dibuka atau sudah melewati batas waktu toleransi.' -ExpectEnvelopeFail -Code 'CHECKIN_WINDOW_EXCEEDED')
}
$vNA = New-Approvable -Loc $LOC1
if (Check-Pre 'G-13' 'P0' 'Visit requested untuk check-in' $vNA) {
  [void](Check 'G-14' 'P0' 'Check-in pada status requested -> 409 CONFLICT' 409 `
    (Invoke-Api -Method POST -Path "/visits/$($vNA.id)/checkin" -Token $SEC1 -Body @{}) `
    'Kunjungan berstatus "requested" tidak dapat di-check-in.' -ExpectEnvelopeFail -Code 'CONFLICT')
}
$vCx = New-Approved -Loc $LOC2 -S 30 -E 180
if (Check-Pre 'G-15' 'P0' 'Visit approved cabang2 untuk cross-branch gate' $vCx) {
  Write-Host ("  G-15 visit = " + $vCx.visit_id)
  [void](Check 'G-16' 'P0' 'Check-in cabang2 oleh security cabang1 -> 403' 403 `
    (Invoke-Api -Method POST -Path "/visits/$($vCx.id)/checkin" -Token $SEC1 -Body @{}) `
    'Tidak berhak mengelola kunjungan cabang lain' -ExpectEnvelopeFail)
}
$vPhoto = New-Approved -Loc $LOC1 -S 30 -E 180
if (Check-Pre 'G-17' 'P1' 'Visit approved untuk check-in bukti foto' $vPhoto) {
  [void](Check 'G-18' 'P1' 'Check-in dengan photo_url MinIO valid -> 200' 200 `
    (Invoke-Api -Method POST -Path "/visits/$($vPhoto.id)/checkin" -Token $SEC1 -Body @{ photo_url = "http://localhost:9000/thc-vms-bucket/checkin_photo/$($TAG -replace '[\[\]]','')/evidence.jpg" }))
}

# ═════════════════════════ H. CHECK-OUT (P0) ═════════════════════════
Write-Host "`n=== H. CHECK-OUT ===" -ForegroundColor Cyan
if ($null -ne $vIn1) {
  [void](Check 'H-01' 'P0' 'Check-out tiket yang SAMA dengan check-in -> 200' 200 `
    (Invoke-Api -Method POST -Path "/visits/$($vIn1.id)/checkout" -Token $SEC1 -Body @{}))
  [void](Check 'H-02' 'P0' 'Double check-out -> 409 CONFLICT' 409 `
    (Invoke-Api -Method POST -Path "/visits/$($vIn1.id)/checkout" -Token $SEC1 -Body @{}) `
    'Kunjungan berstatus "completed" tidak dapat di-check-out.' -ExpectEnvelopeFail -Code 'CONFLICT')
}
$vNoIn = New-Approved -Loc $LOC1 -S 30 -E 180
if (Check-Pre 'H-03' 'P0' 'Visit approved tanpa check-in' $vNoIn) {
  Write-Host ("  H-03 visit = " + $vNoIn.visit_id)
  [void](Check 'H-04' 'P0' 'Check-out tanpa check-in -> 409 CONFLICT' 409 `
    (Invoke-Api -Method POST -Path "/visits/$($vNoIn.id)/checkout" -Token $SEC1 -Body @{}) `
    'Kunjungan berstatus "approved" tidak dapat di-check-out.' -ExpectEnvelopeFail)
  [void](Check 'H-05' 'P0' 'Check-out oleh vendor -> 403' 403 `
    (Invoke-Api -Method POST -Path "/visits/$($vNoIn.id)/checkout" -Token $VENDOR1 -Body @{}) `
    'Tidak berhak mengelola kunjungan cabang lain' -ExpectEnvelopeFail)
}
if ($null -ne $vCx) {
  [void](Check 'H-06' 'P0' 'Check-out lintas cabang -> 403' 403 `
    (Invoke-Api -Method POST -Path "/visits/$($vCx.id)/checkout" -Token $SEC1 -Body @{}) `
    'Tidak berhak mengelola kunjungan cabang lain' -ExpectEnvelopeFail)
}
$vAin = New-Approved -Loc $LOC1 -S 30 -E 180
if (Check-Pre 'H-07' 'P0' 'Visit approved untuk cancel-setelah-checkin' $vAin) {
  [void](Invoke-Api -Method POST -Path "/visits/$($vAin.id)/checkin" -Token $SEC1 -Body @{})
  [void](Check 'H-08' 'P0' 'Cancel setelah check-in -> 409 INVALID_TRANSITION' 409 `
    (Invoke-Api -Method POST -Path "/visits/$($vAin.id)/cancel" -Token $ADM1 -Body @{ reason = "$TAG batal setelah check-in" }) `
    'Transisi status kunjungan tidak diizinkan.' -ExpectEnvelopeFail)
}
$vAin2 = New-Approved -Loc $LOC1 -S 30 -E 180
if (Check-Pre 'H-09' 'P0' 'Visit approved untuk dual-role check-out' $vAin2) {
  [void](Invoke-Api -Method POST -Path "/visits/$($vAin2.id)/checkin" -Token $SEC1 -Body @{})
  [void](Check 'H-10' 'P0' 'Check-out oleh ADMIN CABANG (dual-role) -> 200' 200 `
    (Invoke-Api -Method POST -Path "/visits/$($vAin2.id)/checkout" -Token $ADM1 -Body @{}))
}

# ═════════════════════════ I. UPLOADS (P1) ═════════════════════════
Write-Host "`n=== I. UPLOADS ===" -ForegroundColor Cyan
$r = Upload-File -Token $VENDOR1 -FilePath "$FixtureDir\spk.pdf" -Category 'assignment_letter' -OwnerId 'e2ebb-staging'
$okU = Check 'I-01' 'P1' 'Upload SPK PDF asli (assignment_letter) -> 201' 201 $r
if ($okU) {
  $u = [string]$r.Json.data.file_url
  Add-R 'I-02' 'P1' 'Respons upload mengembalikan file_url absolut MinIO' `
    ($u -like 'http://localhost:9000/*') 'http://localhost:9000/...' $u `
    "file_name=$($r.Json.data.file_name) size=$($r.Json.data.file_size) mime=$($r.Json.data.mime_type)"
}
[void](Check 'I-03' 'P1' 'Upload foto KTP PNG asli (id_card) -> 201' 201 `
  (Upload-File -Token $VENDOR1 -FilePath "$FixtureDir\ktp.png" -Category 'id_card' -OwnerId 'e2ebb-ktp'))
[void](Check 'I-04' 'P1' 'Upload foto selfie JPEG (checkin_photo) -> 201' 201 `
  (Upload-File -Token $VENDOR1 -FilePath "$FixtureDir\selfie.jpg" -Category 'checkin_photo' -OwnerId 'e2ebb-selfie'))
[void](Check 'I-05' 'P1' 'Upload file > 5MB -> 413 FILE_TOO_LARGE' 413 `
  (Upload-File -Token $VENDOR1 -FilePath "$FixtureDir\big.png" -Category 'id_card' -OwnerId 'e2ebb-big') `
  'Ukuran berkas melebihi batas 5242880 byte.' -ExpectEnvelopeFail -Code 'FILE_TOO_LARGE')
[void](Check 'I-06' 'P1' 'Upload .exe (MIME terlarang) -> 400 STORAGE_REJECTED' 400 `
  (Upload-File -Token $VENDOR1 -FilePath "$FixtureDir\evil.exe" -Category 'assignment_letter' -OwnerId 'e2ebb-exe') `
  'berkas ditolak: ukuran atau tipe tidak diizinkan' -ExpectEnvelopeFail -Code 'STORAGE_REJECTED')
[void](Check 'I-07' 'P1' 'Upload kategori tidak dikenal -> 400' 400 `
  (Upload-File -Token $VENDOR1 -FilePath "$FixtureDir\ktp.png" -Category 'kategori_ngawur' -OwnerId 'e2ebb-cat') `
  'Kategori berkas tidak dikenal.' -ExpectEnvelopeFail -Code 'VALIDATION_ERROR')
[void](Check 'I-08' 'P1' 'Upload tanpa token -> 401 UNAUTHORIZED' 401 `
  (Upload-File -Token '' -FilePath "$FixtureDir\ktp.png" -Category 'id_card' -OwnerId 'e2ebb-anon') `
  'Token tidak valid atau kedaluwarsa.' -ExpectEnvelopeFail)

# ═════════════════════════ J. USERS / SECURITY / LOCATIONS RBAC (P1) ═════════════════════════
Write-Host "`n=== J. USERS/SECURITY/LOCATIONS RBAC ===" -ForegroundColor Cyan
$stamp   = (Get-Date).ToString('HHmmss')
$emailNew = "e2ebbsec$stamp@thc.local"
$r = Invoke-Api -Method GET -Path '/users/security?limit=200' -Token $ADM1
$secItems = @($r.Json.data)
$bad = @($secItems | Where-Object { $_.location_id -and [string]$_.location_id -ne $LOC1 })
Add-R 'J-01' 'P0' 'GET /users/security oleh admin -> hanya cabangnya' `
  (($r.Status -eq 200) -and ($bad.Count -eq 0)) "200 semua location=$LOC1" `
  $(if ($bad.Count) { "bocor $($bad.Count)" } else { 'OK' }) `
  "status=$($r.Status) akun=$($secItems.Count) lokasi_unik=$(@($secItems | ForEach-Object { $_.location_id } | Select-Object -Unique).Count)"
[void](Check 'J-02' 'P0' 'GET /users/security oleh vendor -> 403' 403 (Invoke-Api -Method GET -Path '/users/security' -Token $VENDOR1) `
  'Tidak berhak mengelola kunjungan cabang lain' -ExpectEnvelopeFail -Code 'FORBIDDEN_BRANCH')
[void](Check 'J-03' 'P0' 'GET /users/security oleh security -> 403' 403 (Invoke-Api -Method GET -Path '/users/security' -Token $SEC1) `
  'Tidak berhak mengelola kunjungan cabang lain' -ExpectEnvelopeFail)
$r = Invoke-Api -Method POST -Path '/users/security' -Token $ADM1 -Body @{ name = "$TAG Pengawas Uji 1"; email = $emailNew; password = 'E2eBb123!' }
$newSec = $null
if ($r.Status -eq 201 -and $r.Json.data.id) { $newSec = $r.Json.data; Track-SecUser ([string]$newSec.id) }
$okS = Check 'J-04' 'P0' 'POST /users/security admin cabang sendiri -> 201' 201 $r
if ($okS) {
  Write-Host ("  J-04 pengawas baru = " + $newSec.id)
  Add-R 'J-05' 'P0' 'Pengawas baru terikat otomatis ke location_id adminnya' `
    ([string]$newSec.location_id -eq $LOC1) "location_id=$LOC1" "location_id=$($newSec.location_id)" `
    ($newSec | ConvertTo-Json -Compress)
  [void](Check 'J-06' 'P0' 'PATCH /users/security/{id}/status oleh admin cabangnya -> 200' 200 `
    (Invoke-Api -Method PATCH -Path "/users/security/$($newSec.id)/status" -Token $ADM1 -Body @{ status = 'inactive' }))
  [void](Check 'J-07' 'P0' 'Akun security hasil create nonaktif -> login 401' 401 `
    (Invoke-Api -Method POST -Path '/auth/login' -Body @{ email = $emailNew; password = 'E2eBb123!' }) `
    'Kredensial tidak valid' -ExpectEnvelopeFail -Code 'INVALID_CREDENTIALS')
  [void](Check 'J-08' 'P0' 'PATCH /users/security/{id} oleh vendor -> 403' 403 `
    (Invoke-Api -Method PATCH -Path "/users/security/$($newSec.id)" -Token $VENDOR1 -Body @{ name = 'x' }) `
    'Tidak berhak mengelola kunjungan cabang lain' -ExpectEnvelopeFail)
}
# J-09: untuk peran admin, location_id di-body DIABAIKAN dan akun dipaku ke
# cabang pemanggil (createSecurityUserBody: location_id honoured for
# super_admin only). Jadi 201 + pin ke LOC1 = perilaku benar: BUKAN eskalasi
# lintas cabang. Akun yang tetap dibuat harus tetap DITRACK agar tidak bocor.
$rJ9 = Invoke-Api -Method POST -Path '/users/security' -Token $ADM1 -Body @{
  name = "$TAG Pengawas X"; email = "e2ebbxx$stamp@thc.local"; password = 'E2eBb123!'; location_id = $LOC2
}
$j9Sec = $null
if ($rJ9.Status -eq 201 -and $rJ9.Json.data.id) { $j9Sec = $rJ9.Json.data; Track-SecUser ([string]$j9Sec.id) }
[void](Check 'J-09' 'P0' 'POST /users/security dgn location_id cabang lain -> 201 (bukan 403, lihat J-09b)' 201 $rJ9)
Add-R 'J-09b' 'P0' 'location_id cabang lain DIABAIKAN: pengawas dipin ke cabang admin pemanggil (anti-eskalasi)' `
  ([string]$j9Sec.location_id -eq $LOC1) "location_id=$LOC1" "location_id=$($j9Sec.location_id)" `
  ($j9Sec | ConvertTo-Json -Compress)
[void](Check 'J-10' 'P0' 'PATCH /users/security/{id}/status security cabang LAIN -> 403' 403 `
  (Invoke-Api -Method PATCH -Path "/users/security/$SECID2/status" -Token $ADM1 -Body @{ status = 'inactive' }) `
  'Tidak berhak mengelola kunjungan cabang lain' -ExpectEnvelopeFail)
[void](Check 'J-11' 'P0' 'PATCH /users/security/{id} cabang LAIN -> 403' 403 `
  (Invoke-Api -Method PATCH -Path "/users/security/$SECID2" -Token $ADM1 -Body @{ name = "$TAG x" }) `
  'Tidak berhak mengubah akun security dari cabang lain.' -ExpectEnvelopeFail)
[void](Check 'J-12' 'P0' 'DELETE /users/security/{id} cabang LAIN -> 403' 403 `
  (Invoke-Api -Method DELETE -Path "/users/security/$SECID2" -Token $ADM1) `
  'Tidak berhak menghapus akun security dari cabang lain.' -ExpectEnvelopeFail)
[void](Check 'J-13' 'P0' 'GET /users oleh admin -> 403 (back-office superadmin)' 403 `
  (Invoke-Api -Method GET -Path '/users' -Token $ADM1) `
  'Tidak berhak mengelola kunjungan cabang lain' -ExpectEnvelopeFail)
$r = Invoke-Api -Method GET -Path '/users?limit=200' -Token $SA
$allUsers = @($r.Json.data)
Add-R 'J-14' 'P0' 'GET /users oleh superadmin -> 200, lintas cabang' `
  (($r.Status -eq 200) -and ($allUsers.Count -gt 0)) '200 + >0 akun' "$($r.Status) akun=$($allUsers.Count)" `
  "lokasi_unik=$(@($allUsers | Where-Object { $_.location_id } | ForEach-Object { $_.location_id } | Select-Object -Unique).Count)"
$r = Invoke-Api -Method POST -Path '/users' -Token $SA -Body @{
  name = "$TAG Vendor Uji"; email = "e2ebbvendor$stamp@thc.local"; password = 'E2eBb123!'
  role = 'vendor'; nik = '3578010200009999'; vendor_id = $VDA; vendor_name = "$TAG Manual Corp"
}
$newUser = $null
if ($r.Status -eq 201 -and $r.Json.data.id) { $newUser = $r.Json.data; Track-User ([string]$newUser.id) }
$okJU = Check 'J-15' 'P0' 'POST /users superadmin (vendor+vendor_id+vendor_name+NIK) -> 201' 201 $r
if ($okJU) {
  Write-Host ("  J-15 user vendor baru = " + $newUser.id)
  # J-16: accountDTO dari POST /users SENGAJA tidak memuat vendor_id, dan
  # vendor_name hanya terisi bila override manual diketik (yaitu saat vendor_id
  # ABSEN - lihat superadmin_handler.go CreateUser). Join katalog hanya ada pada
  # baca daftar. Catatan: TIDAK ADA route GET /users/{id} (router.go hanya
  # mendaftarkan GET /users, POST /users, PATCH /users/:id[ /status],
  # DELETE /users/:id) - memakai /users/{id} akan 404 dan mengarang endpoint.
  # Jadi "katalog menang atas ketikan manual" dibaca dari GET /users: baris akun
  # baru harus memuat nama katalog, BUKAN string manual yang dikirim.
  $VDA_NAME = @(@((Invoke-Api -Method GET -Path '/vendors' -Token $SA).Json.data) |
                Where-Object { [string]$_.id -eq [string]$VDA } | Select-Object -First 1).name
  $ul = Invoke-Api -Method GET -Path '/users?limit=200' -Token $SA
  $row = @(@($ul.Json.data) | Where-Object { [string]$_.id -eq [string]$newUser.id } | Select-Object -First 1)
  $rowVendorName = ''
  if ($row.Count -gt 0) { $rowVendorName = [string]$row[0].vendor_name }
  Add-R 'J-16' 'P0' 'Vendor_id katalog menang atas vendor_name ketikan manual (baca GET /users)' `
    (($ul.Status -eq 200) -and ($row.Count -eq 1) -and ($rowVendorName -eq [string]$VDA_NAME)) `
    "vendor_name=$VDA_NAME" "status=$($ul.Status) baris=$($row.Count) vendor_name='$rowVendorName'" `
    ($row | ConvertTo-Json -Compress)
  $vl = Invoke-Api -Method GET -Path '/visits?limit=100' -Token $SA
  $vendorRows = @(@($vl.Json.data.items) | Where-Object { [string]$_.vendor_user.id -eq [string]$newUser.id })
  Add-R 'J-17' 'P0' 'Akun vendor baru tidak melihat kunjungan orang lain (scope vendor_user)' `
    ($vendorRows.Count -eq 0) '0 baris milik vendor baru' "$($vendorRows.Count) baris" `
    "total_visit_sa=$($vl.Json.data.total)"
}
[void](Check 'J-18' 'P0' 'POST /users dengan role super_admin -> 400' 400 `
  (Invoke-Api -Method POST -Path '/users' -Token $SA -Body @{ name = 'x'; email = "e2ebbad$stamp@thc.local"; password = 'E2eBb123!'; role = 'super_admin' }) `
  'Akun super_admin tidak dapat dibuat melalui endpoint ini.' -ExpectEnvelopeFail)
[void](Check 'J-19' 'P0' 'POST /users role security -> 400 (harus via /users/security)' 400 `
  (Invoke-Api -Method POST -Path '/users' -Token $SA -Body @{ name = 'x'; email = "e2ebbse$stamp@thc.local"; password = 'E2eBb123!'; role = 'security' }) `
  'Akun security dibuat melalui POST /users/security.' -ExpectEnvelopeFail)
[void](Check 'J-20' 'P0' 'POST /users NIK bukan 16 digit -> 400' 400 `
  (Invoke-Api -Method POST -Path '/users' -Token $SA -Body @{ name = 'x'; email = "e2ebbnik$stamp@thc.local"; password = 'E2eBb123!'; role = 'vendor'; nik = '12345'; vendor_id = $VDA }) `
  'NIK harus 16 digit numerik.' -ExpectEnvelopeFail)
[void](Check 'J-21' 'P0' 'POST /users oleh vendor -> 403' 403 `
  (Invoke-Api -Method POST -Path '/users' -Token $VENDOR1 -Body @{ name = 'x'; email = "e2ebbv$stamp@thc.local"; password = 'E2eBb123!'; role = 'vendor' }) `
  'Tidak berhak mengelola kunjungan cabang lain' -ExpectEnvelopeFail)
[void](Check 'J-22' 'P1' 'POST /locations oleh admin -> 403' 403 `
  (Invoke-Api -Method POST -Path '/locations' -Token $ADM1 -Body @{ name = "$TAG POP Uji"; code = 'E2E-TEST' }) `
  'Tidak berhak mengelola kunjungan cabang lain' -ExpectEnvelopeFail)
$r = Invoke-Api -Method POST -Path '/locations' -Token $SA -Body @{ name = "$TAG POP Uji"; code = "E2E-$stamp"; type = 'pop'; address = 'Jalan Uji E2E'; capacity = 1 }
$newLoc = $null
if ($r.Status -eq 201 -and $r.Json.data.id) { $newLoc = $r.Json.data; Track-Location ([string]$newLoc.id) }
$okL = Check 'J-23' 'P1' 'POST /locations oleh superadmin -> 201' 201 $r
if ($okL) {
  Write-Host ("  J-23 lokasi baru = " + $newLoc.id)
  [void](Check 'J-24' 'P1' 'PATCH /locations/{id} oleh superadmin -> 200' 200 `
    (Invoke-Api -Method PATCH -Path "/locations/$($newLoc.id)" -Token $SA -Body @{ name = "$TAG POP Uji Ubah" }))
  [void](Check 'J-25' 'P1' 'PATCH /locations/{id} oleh admin -> 403' 403 `
    (Invoke-Api -Method PATCH -Path "/locations/$($newLoc.id)" -Token $ADM1 -Body @{ name = 'x' }) `
    'Tidak berhak mengelola kunjungan cabang lain' -ExpectEnvelopeFail)
}
[void](Check 'J-26' 'P1' 'GET /vendors oleh security (master data read) -> 200' 200 `
  (Invoke-Api -Method GET -Path '/vendors' -Token $SEC1))
# active_only=false DIDUKUNG (frontend listLocations(false) mengirim
# ?active_only=false). Ekspektasi lama "param tak didukung -> 400" salah.
$rlAll = Invoke-Api -Method GET -Path '/locations?active_only=false' -Token $SA
[void](Check 'J-27' 'P1' 'GET /locations?active_only=false -> 200 (param didukung)' 200 $rlAll)
Add-R 'J-28' 'P1' 'active_only=false tetap menampilkan seluruh lokasi katalog' `
  (($rlAll.Status -eq 200) -and (@($rlAll.Json.data).Count -ge 5)) `
  '>=5 lokasi' "status=$($rlAll.Status) lokasi=$(@($rlAll.Json.data).Count)" `
  ($rlAll.Json | ConvertTo-Json -Compress -Depth 4)

# /visits punya batas keras maxListLimit=100 (backend/internal/usecase/visit/list.go).
# Nilai limit di atas 100 TIDAK divalidasi: ia di-DROP ke defaultListLimit=10.
# Akibatnya `?limit=200` hanya mengembalikan 10 baris pertama dan verifikasi
# baris terlindungi dilaporkan "hilang" padahal masih ada -> false negative.
# Karena itu semua pembacaan yang butuh SELURUH baris memakai helper ini.
function Get-AllVisits {
  param([string]$Token, [int]$MaxPages = 25)
  $items = New-Object System.Collections.ArrayList
  $page = 1
  while ($page -le $MaxPages) {
    $r = Invoke-Api -Method GET -Path "/visits?limit=100&page=$page" -Token $Token
    if ($r.Status -ne 200 -or -not $r.Json.data) { break }
    $batch = @($r.Json.data.items)
    foreach ($it in $batch) { [void]$items.Add($it) }
    $total = [int]$r.Json.data.total
    if ($batch.Count -eq 0 -or $items.Count -ge $total) { break }
    $page++
  }
  return @($items.ToArray())
}

# ═════════════════════════ CLEANUP (ID PERSIS SAJA) ═════════════════════════
Write-Host "`n=== CLEANUP ===" -ForegroundColor Cyan
function Del-V1 { param([string]$Token, [string]$Path) return (Invoke-Api -Method DELETE -Path $Path -Token $Token).Status }
$cleanup = [pscustomobject]@{
  Visits = 0; VisitFail = 0; SecUsers = 0; SecUserFail = 0
  Users = 0; UserFail = 0; Locations = 0; LocationFail = 0
}
Write-Host "  menghapus $($script:CreatedVisits.Count) kunjungan / $($script:CreatedSecUsers.Count) pengawas / $($script:CreatedUsers.Count) user / $($script:CreatedLocations.Count) lokasi (ID PERSIS)"

# 404 saat DELETE = baris sudah tidak ada (mis. dihapus oleh skenario delete
# seperti F-05). Itu berarti BERSIH, bukan kegagalan - selama ID-nya persis
# milik skrip ini. Menandainya gagal hanya menghasilkan false positive.
foreach ($id in @($script:CreatedVisits)) {
  $sc = Del-V1 $SA "/visits/$id"
  if ($sc -eq 204) { $cleanup.Visits++ } elseif ($sc -eq 404) { $cleanup.Visits++ }
  else { $cleanup.VisitFail++; Write-Host "  ! visit $id => $sc" -ForegroundColor Red }
}
foreach ($id in @($script:CreatedSecUsers)) {
  $sc = Del-V1 $SA "/users/security/$id"
  if ($sc -eq 204) { $cleanup.SecUsers++ } elseif ($sc -eq 404) { $cleanup.SecUsers++ }
  else { $cleanup.SecUserFail++; Write-Host "  ! secuser $id => $sc" -ForegroundColor Red }
}
foreach ($id in @($script:CreatedUsers)) {
  $sc = Del-V1 $SA "/users/$id"
  if ($sc -eq 204) { $cleanup.Users++ } elseif ($sc -eq 404) { $cleanup.Users++ }
  else { $cleanup.UserFail++; Write-Host "  ! user $id => $sc" -ForegroundColor Red }
}
foreach ($id in @($script:CreatedLocations)) {
  $sc = Del-V1 $SA "/locations/$id"
  if ($sc -eq 204) { $cleanup.Locations++ } elseif ($sc -eq 404) { $cleanup.Locations++ }
  else { $cleanup.LocationFail++; Write-Host "  ! location $id => $sc" -ForegroundColor Red }
}
Write-Host ("  terhapus: kunjungan=$($cleanup.Visits) pengawas=$($cleanup.SecUsers) user=$($cleanup.Users) lokasi=$($cleanup.Locations)")
Write-Host ("  gagal   : kunjungan=$($cleanup.VisitFail) pengawas=$($cleanup.SecUserFail) user=$($cleanup.UserFail) lokasi=$($cleanup.LocationFail)")

# Verifikasi sisa per-ID (TIDAK pakai ?search= - API tidak mengimplementasikannya).
$stillThere = New-Object System.Collections.ArrayList
foreach ($id in @($script:CreatedVisits)) {
  $g = Invoke-Api -Method GET -Path "/visits/$id" -Token $SA
  if ($g.Status -ne 404) { [void]$stillThere.Add("visit:$id=>$($g.Status)") }
}
$stillSec = New-Object System.Collections.ArrayList
foreach ($id in @($script:CreatedSecUsers)) {
  $g = Invoke-Api -Method GET -Path "/users/security?limit=200" -Token $SA
  $hit = @(@($g.Json.data) | Where-Object { [string]$_.id -eq [string]$id })
  if ($hit.Count -gt 0) { [void]$stillSec.Add("sec:$id") }
}
$stillUser = New-Object System.Collections.ArrayList
foreach ($id in @($script:CreatedUsers)) {
  $g = Invoke-Api -Method GET -Path '/users?limit=200' -Token $SA
  $hit = @(@($g.Json.data) | Where-Object { [string]$_.id -eq [string]$id })
  if ($hit.Count -gt 0) { [void]$stillUser.Add("user:$id") }
}
$stillLoc = New-Object System.Collections.ArrayList
foreach ($id in @($script:CreatedLocations)) {
  $g = Invoke-Api -Method GET -Path '/locations' -Token $SA
  $hit = @(@($g.Json.data) | Where-Object { [string]$_.id -eq [string]$id })
  if ($hit.Count -gt 0) { [void]$stillLoc.Add("loc:$id") }
}
$REMAIN_VISIT = $stillThere.Count
$REMAIN_SEC   = $stillSec.Count
$REMAIN_USER  = $stillUser.Count
$REMAIN_LOC   = $stillLoc.Count
Add-R 'CL-01' 'P0' 'Sisa kunjungan uji = 0 (verifikasi GET per-ID -> 404)' `
  ($REMAIN_VISIT -eq 0) '0' "$REMAIN_VISIT" ($stillThere -join ',')
Add-R 'CL-02' 'P0' 'Sisa pengawas uji = 0' ($REMAIN_SEC -eq 0) '0' "$REMAIN_SEC" ($stillSec -join ',')
Add-R 'CL-03' 'P0' 'Sisa user uji = 0' ($REMAIN_USER -eq 0) '0' "$REMAIN_USER" ($stillUser -join ',')
Add-R 'CL-04' 'P0' 'Sisa lokasi uji = 0' ($REMAIN_LOC -eq 0) '0' "$REMAIN_LOC" ($stillLoc -join ',')

# Baris milik user lain HARUS utuh - tidak pernah disentuh skrip ini.
# Dibaca lewat Get-AllVisits (limit=100 + paging), bukan ?limit=200 yang hanya
# mengembalikan 20 baris pertama sehingga baris terlindung tampak hilang.
$afterItems = @(Get-AllVisits -Token $SA)
$afterCount = (Invoke-Api -Method GET -Path '/visits?limit=1' -Token $SA)
$PROTECTED = @('3523808258', '7087842281')
$protFound = @()
foreach ($p in $PROTECTED) {
  $hit = @($afterItems | Where-Object { [string]$_.visit_id -eq "VST-$p" })
  if ($hit.Count -gt 0) { $protFound += "$($hit[0].visit_id)($($hit[0].status))" }
}
Add-R 'CL-05' 'P0' 'Baris manual user lain utuh (VST-3523808258 / VST-7087842281)' `
  ($protFound.Count -eq 2) '2 dari 2 utuh' "$($protFound.Count) dari 2" `
  "baris_terbaca=$($afterItems.Count) " + ($protFound -join ' ')
$AFTER_TOTAL = [int]$afterCount.Json.data.total
Add-R 'CL-06' 'P0' 'Total kunjungan kembali ke baseline (tidak ada sisa/baris baru)' `
  ($AFTER_TOTAL -eq $BASELINE) "baseline=$BASELINE" "after=$AFTER_TOTAL" "dibuat=$($script:CreatedVisits.Count) dihapus=$($cleanup.Visits)"

# ═════════════════════════ LAPORAN ═════════════════════════
$pass = @($script:Results | Where-Object { $_.Ok }).Count
$fail = @($script:Results | Where-Object { -not $_.Ok }).Count
$script:Http.Dispose()
Write-Host ("`n" + ('=' * 120))
Write-Host "RINGKASAN BLACKBOX E2E  |  TOTAL: $($script:Results.Count)  |  PASS: $pass  |  FAIL: $fail" `
  -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
Write-Host ('=' * 120)
foreach ($r in $script:Results) {
  $mark = if ($r.Ok) { 'PASS' } else { 'FAIL' }
  $col  = if ($r.Ok) { 'Green' } else { 'Red' }
  Write-Host ("{0,-4} {1,-6} {2,-2} {3,-52} | exp={4,-50} | act={5}" -f $mark, $r.Id, $r.Pri, $r.Desc, $r.Expect, $r.Actual) -ForegroundColor $col
}
Write-Host ('=' * 120)
Write-Host ("CLEANUP  : dibuat(hapus)=($($script:CreatedVisits.Count))($($cleanup.Visits)) | pengawas=($($script:CreatedSecUsers.Count))($($cleanup.SecUsers)) | user=($($script:CreatedUsers.Count))($($cleanup.Users)) | lokasi=($($script:CreatedLocations.Count))($($cleanup.Locations))")
Write-Host ("SISA     : kunjungan=$REMAIN_VISIT pengawas=$REMAIN_SEC user=$REMAIN_USER lokasi=$REMAIN_LOC")
Write-Host ("BASELINE : total sebelum=$BASELINE total sesudah=$AFTER_TOTAL | baris manual terlindungi utuh=$($protFound.Count)/2")
if ($fail -gt 0) { exit 1 } else { exit 0 }
