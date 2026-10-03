<#
.SYNOPSIS
Seeds 50 lifelike DEMO visits (10 vendors x 5 branches) through the REAL HTTP API.

.DESCRIPTION
Drives the live backend exactly like the frontend does (same endpoints, payloads
and validation per docs/4. openapi.yaml): login -> /me discovery -> /uploads ->
POST /visits (vendor only) -> approve/reject -> checkin -> checkout, then prints a
count report per branch / status / role.

RERUNNABLE: every run creates 50 NEW visits. Technician id_number/phone values
are stamped with the current time (MMddHHmmss) so a second run can never collide
with rows from a previous run on unique columns. The script never deletes,
wipes, migrates down, or resets anything; pre-existing rows are left untouched.

PRECONDITIONS (done OUTSIDE this script, forward-only):
  docker compose up -d                      # postgres + minio
  migrate ... up                            # must be at 000003+000004, NEVER down
  vms be restart                            # rebuild + restart ONLY the backend
  GET /health must answer 200.

All 50 visits are filed BY VENDOR ACCOUNTS ONLY (admin/security/superadmin file
nothing). Approvals come from each branch's own admin (koordinator), check-in
and check-out from each branch's own security (pengawas); exactly 2 approvals
are done by superadmin (HQ). Every role participates.

USAGE:
  powershell -NoProfile -ExecutionPolicy Bypass -File backend/scripts/seed_demo_visits.ps1
  powershell ... seed_demo_visits.ps1 -BaseUrl "http://localhost:8080/api/v1" -Password "Password123!"

Matches docs/5. LOCAL_DEV.md section 6.1 (uniform demo password for all
seeded accounts) and mirrors backend/scripts/qa_mvp.ps1 Invoke-RestMethod
patterns, but stays PowerShell 5.1-compatible (no SkipHttpErrorCheck, no
ternary, no null-coalescing operators).
#>
[CmdletBinding()]
param(
    [string]$BaseUrl = "http://localhost:8080/api/v1",
    # Uniform demo password for every seeded account (docs/5. LOCAL_DEV.md 6.1).
    [string]$Password = "Password123!",
    [string]$SuperadminEmail = "superadmin@thc.net.id"
)

$ErrorActionPreference = 'Stop'
$script:Fail = 0
$script:Failures = [System.Collections.Generic.List[string]]::new()

function Write-Log([string]$line) { Write-Host $line }

function Note-Fail([string]$what, [string]$detail) {
    $script:Fail++
    $msg = "FAIL  $what  << $detail"
    $script:Failures.Add($msg)
    Write-Log $msg
}

# Invoke-Api: one HTTP call, never throws; 4xx/5xx are observations.
# PowerShell 5.1 compatible: Invoke-WebRequest + ErrorDetails/stream fallback.
function Invoke-Api {
    param(
        [string]$Method = "GET",
        [string]$Path = "/",
        $Body = $null,
        [hashtable]$Headers = @{}
    )
    $uri = "$BaseUrl$Path"
    $params = @{
        Method          = $Method
        Uri             = $uri
        Headers         = $Headers
        TimeoutSec      = 30
        ErrorAction     = 'Stop'
        UseBasicParsing = $true
    }
    if ($null -ne $Body) {
        $params.Body = ($Body | ConvertTo-Json -Depth 10 -Compress)
        $params.ContentType = "application/json"
    }
    try {
        $r = Invoke-WebRequest @params
        $status = [int]$r.StatusCode
        $raw = $r.Content
    } catch {
        $status = 0
        $raw = ""
        try {
            $resp = $_.Exception.Response
            if ($resp) { $status = [int]$resp.StatusCode }
        } catch { }
        try {
            if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $raw = $_.ErrorDetails.Message }
        } catch { }
        if (-not $raw) {
            try {
                $stream = $_.Exception.Response.GetResponseStream()
                if ($stream) {
                    $sr = New-Object System.IO.StreamReader($stream)
                    $raw = $sr.ReadToEnd()
                }
            } catch { }
        }
        if (-not $raw) { $raw = $_.Exception.Message }
    }
    $parsed = $null
    if ($raw) { try { $parsed = $raw | ConvertFrom-Json } catch { $parsed = $null } }
    return [pscustomobject]@{ Status = $status; Raw = $raw; Body = $parsed }
}

function Auth([string]$token) { return @{ Authorization = "Bearer $token" } }

function Login([string]$email) {
    $r = Invoke-Api -Method POST -Path "/auth/login" -Body @{ email = $email; password = $Password }
    if ($r.Status -eq 200 -and $r.Body.success) { return $r.Body.data.token }
    Note-Fail "login $email" "HTTP $($r.Status) $($r.Raw)"
    return $null
}

function Get-Me([string]$token) {
    $r = Invoke-Api -Path "/auth/me" -Headers (Auth $token)
    if ($r.Status -eq 200 -and $r.Body.success) { return $r.Body.data }
    Note-Fail "GET /me" "HTTP $($r.Status) $($r.Raw)"
    return $null
}

# Uploads go through curl.exe -F like qa_mvp.ps1: it derives each part's
# Content-Type from the file extension, which is the header validated server-side.
function Invoke-Upload([string]$token, [string]$path, [string]$mime, [string]$category) {
    $json = curl.exe -s -w "`n%{http_code}" -X POST "$BaseUrl/uploads" `
        -H "Authorization: Bearer $token" `
        -F "file=@$path;type=$mime" `
        -F "category=$category"
    $lines = @($json -split "`n")
    $status = 0
    try { $status = [int]($lines | Where-Object { $_ -match '^\d{3}$' } | Select-Object -Last 1) } catch { }
    $raw = ($lines | Where-Object { $_ -notmatch '^\d{3}$' }) -join ""
    $parsed = $null
    if ($raw) { try { $parsed = $raw | ConvertFrom-Json } catch { } }
    return [pscustomobject]@{ Status = $status; Raw = $raw; Body = $parsed }
}

function Iso([datetime]$t) { return $t.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }

Write-Log "=============================================================="
Write-Log " THC-VMS demo seed  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Log " target: $BaseUrl   (50 visits = 10 vendors x 5 branches)"
Write-Log "=============================================================="

# ---------------------------------------------------------------- health
$health = Invoke-Api -Path "/health"
if ($health.Status -ne 200) {
    Write-Log "FATAL: /health returned HTTP $($health.Status). Start the stack first (vms be restart)."
    exit 1
}
Write-Log "health: OK"

# ------------------------------------------------- superadmin + catalogs
$saToken = Login $SuperadminEmail
if (-not $saToken) { Write-Log "FATAL: superadmin login failed."; exit 1 }
Start-Sleep -Seconds 3

$locRes = Invoke-Api -Path "/locations" -Headers (Auth $saToken)
$purRes = Invoke-Api -Path "/purposes" -Headers (Auth $saToken)
$venRes = Invoke-Api -Path "/vendors" -Headers (Auth $saToken)
if ($locRes.Status -ne 200 -or $purRes.Status -ne 200 -or $venRes.Status -ne 200) {
    Write-Log "FATAL: catalog fetch failed."
    exit 1
}
$locations = @($locRes.Body.data | Sort-Object { $_.name })
$purposes = @($purRes.Body.data)
$vendors = @($venRes.Body.data)
if ($locations.Count -ne 5) { Write-Log "FATAL: expected 5 locations, got $($locations.Count)."; exit 1 }
if ($vendors.Count -lt 2) { Write-Log "FATAL: expected >=2 vendors, got $($vendors.Count)."; exit 1 }
$vendor1 = @($vendors | Where-Object { $_.name -eq "PT Lintas Fiber" })[0]
$vendor2 = @($vendors | Where-Object { $_.name -eq "PT Daya Power Mandiri" })[0]
if (-not $vendor1) { $vendor1 = $vendors[0] }
if (-not $vendor2) { $vendor2 = $vendors[1] }
Write-Log ("catalogs: {0} locations, {1} purposes, {2} vendors" -f $locations.Count, $purposes.Count, $vendors.Count)
foreach ($l in $locations) { Write-Log ("  branch: {0} [{1}]" -f $l.name, $l.type) }

# ------------------------------------------- logins: admins/security/vendors
# Login ONCE per account, reuse tokens; ~3s between logins (strict limiter).
$vendorEmails = @("pic1a@thc.com", "pic1b@thc.com", "pic2a@thc.com", "pic2b@thc.com",
    "pic3a@thc.com", "pic3b@thc.com", "pic4a@thc.com", "pic4b@thc.com",
    "pic5a@thc.com", "pic5b@thc.com")
$adminTokens = @{}   # location_id -> token (branch koordinator)
$adminEmails = @{}   # location_id -> email (for the report)
$secTokens = @{}     # location_id -> token (branch pengawas)
$secEmails = @{}     # location_id -> email (for the report)
$vendorTokens = @{}   # email -> token

for ($i = 1; $i -le 5; $i++) {
    $email = "admin$($i)@thc.com"
    $tok = Login $email
    if (-not $tok) { Write-Log "FATAL: cannot login $email."; exit 1 }
    $me = Get-Me $tok
    if (-not $me) { exit 1 }
    $adminTokens[$me.location_id] = $tok
    $adminEmails[$me.location_id] = $email
    Write-Log ("admin: {0,-22} -> {1}" -f $email, $me.location_name)
    Start-Sleep -Seconds 3
}
for ($i = 1; $i -le 5; $i++) {
    $email = "satpam$($i)a@thc.com"
    $tok = Login $email
    if (-not $tok) { Write-Log "FATAL: cannot login $email."; exit 1 }
    $me = Get-Me $tok
    if (-not $me) { exit 1 }
    $secTokens[$me.location_id] = $tok
    $secEmails[$me.location_id] = $email
    Write-Log ("security: {0,-22} -> {1}" -f $email, $me.location_name)
    Start-Sleep -Seconds 3
}
foreach ($email in $vendorEmails) {
    $tok = Login $email
    if (-not $tok) { Write-Log "FATAL: cannot login $email."; exit 1 }
    $vendorTokens[$email] = $tok
    Start-Sleep -Seconds 3
}
Write-Log ("logins: 1 superadmin + {0} admin + {1} security + {2} vendor = {3} tokens" -f $adminTokens.Count, $secTokens.Count, $vendorTokens.Count, (1 + $adminTokens.Count + $secTokens.Count + $vendorTokens.Count))

if ($adminTokens.Count -ne 5 -or $secTokens.Count -ne 5) {
    Write-Log "FATAL: branch mapping incomplete (admin=$($adminTokens.Count) sec=$($secTokens.Count))."
    exit 1
}

# ---------------------------------------------------------------- uploads
# Four tiny dummy files in TEMP; each uploaded ONCE, URLs reused everywhere.
$tmpDir = [System.IO.Path]::GetTempPath()
$stamp = Get-Date -Format "yyyyMMddHHmmss"
$selfie1Path = Join-Path $tmpDir ("demo-selfie1-" + $stamp + ".png")
$selfie2Path = Join-Path $tmpDir ("demo-selfie2-" + $stamp + ".png")
$ktpPath = Join-Path $tmpDir ("demo-ktp-" + $stamp + ".png")
$letterPath = Join-Path $tmpDir ("demo-spk-" + $stamp + ".pdf")
[System.IO.File]::WriteAllBytes($selfie1Path, [byte[]](0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 11, 12, 13, 14, 15, 16))
[System.IO.File]::WriteAllBytes($selfie2Path, [byte[]](0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 21, 22, 23, 24, 25, 26))
[System.IO.File]::WriteAllBytes($ktpPath, [byte[]](0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 31, 32, 33, 34, 35, 36))
$pdfText = "%PDF-1.4`n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj`n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj`ntrailer<</Root 1 0 R>>`n%%EOF`n[DUMMY-DEMO] Surat Tugas SPK fantasi untuk data demo."
[System.IO.File]::WriteAllText($letterPath, $pdfText, (New-Object System.Text.ASCIIEncoding))

$up1 = Invoke-Upload $saToken $selfie1Path "image/png" "id_card"
$up2 = Invoke-Upload $saToken $selfie2Path "image/png" "id_card"
$up3 = Invoke-Upload $saToken $ktpPath "image/png" "id_card"
$up4 = Invoke-Upload $saToken $letterPath "application/pdf" "assignment_letter"
foreach ($u in @($up1, $up2, $up3, $up4)) {
    if ($u.Status -ne 201) { Note-Fail "upload" "HTTP $($u.Status) $($u.Raw)"; Write-Log "FATAL: upload failed."; exit 1 }
}
$selfieUrl1 = $up1.Body.data.file_url
$selfieUrl2 = $up2.Body.data.file_url
$ktpUrl = $up3.Body.data.file_url
$letterUrl = $up4.Body.data.file_url
Write-Log "uploads: 2 selfies + 1 KTP + 1 SPK letter (URLs reused across visits)"
Remove-Item $selfie1Path, $selfie2Path, $ktpPath, $letterPath -Force -ErrorAction SilentlyContinue

# ------------------------------------------------------------------ plan
# Rotation by (vendorIdx + branchIdx): completed / visiting / approved / requested.
# Six overrides -> rejected (one per branch + one extra in branch 0).
# Two approvals (first eligible) are done by superadmin instead of the branch admin.
$rejectedPairs = @("0,0", "1,1", "2,2", "3,3", "4,4", "5,0")
$firstNames = @("Budi", "Agus", "Rina", "Dewi", "Joko", "Slamet", "Wahyu", "Andi",
    "Fitri", "Hadi", "Ratna", "Dedi", "Siti", "Eko", "Yanto", "Supri",
    "Wawan", "Tono", "Dian", "Rudi")
$lastNames = @("Santoso", "Wijaya", "Pratama", "Saputra", "Nugroho", "Hidayat",
    "Kurniawan", "Setiawan", "Laksmana", "Gunawan", "Firmansyah", "Maulana",
    "Hartono", "Susilo", "Riyadi", "Yusuf", "Prasetyo", "Rahayu",
    "Kartika", "Siregar")
$runStamp = Get-Date -Format "MMddHHmmss"   # 10 digits -> unique id_number/phone per run
$now = [DateTime]::UtcNow
$seq = 0

$createdIds = [System.Collections.Generic.List[string]]::new()
$createdCodes = [System.Collections.Generic.List[string]]::new()
$createdBranch = @{}   # visit uuid -> location name
$createdVendor = @{}   # visit uuid -> vendor email
$plannedStatus = @{}   # visit uuid -> planned final status
$countVendor = 0; $countAdminApprove = 0; $countAdminReject = 0
$countSecIn = 0; $countSecOut = 0; $countSuperApprove = 0
$superRemaining = 2

for ($p = 0; $p -lt $vendorEmails.Count; $p++) {
    $vendorEmail = $vendorEmails[$p]
    $vendorTok = $vendorTokens[$vendorEmail]
    for ($b = 0; $b -lt $locations.Count; $b++) {
        $loc = $locations[$b]
        $isRejected = $rejectedPairs -contains ("$p,$b")
        $rot = ($p + $b) % 4
        if ($isRejected) { $final = "rejected" }
        elseif ($rot -eq 0) { $final = "completed" }
        elseif ($rot -eq 1) { $final = "visiting" }
        elseif ($rot -eq 2) { $final = "approved" }
        else { $final = "requested" }

        # Dates: visiting/completed inside the +-2h check-in window
        # (start ~now-30m, end ~now+3h); the rest +2..6 days out.
        if ($final -eq "visiting" -or $final -eq "completed") {
            $start = $now.AddMinutes(-30); $end = $now.AddHours(3)
        } else {
            $dayOff = 2 + (($p + $b) % 5)
            $start = $now.AddDays($dayOff); $end = $start.AddHours(3)
        }

        # 1-2 technicians, realistic Indonesian names, unique id/phone.
        $techCount = 1 + (($p + $b) % 2)
        $visitors = @()
        for ($t = 0; $t -lt $techCount; $t++) {
            $nm = $firstNames[($p * 7 + $b * 3 + $t * 11) % $firstNames.Count] + " " + $lastNames[($p * 5 + $b * 7 + $t * 13) % $lastNames.Count]
            $idn = "3273" + $runStamp + ("{0:D2}" -f $seq)
            $phn = "08" + $runStamp + ("{0:D2}" -f $seq)
            $selfie = $selfieUrl1
            if (($seq % 2) -eq 1) { $selfie = $selfieUrl2 }
            $v = @{
                name              = $nm
                id_number         = $idn
                phone             = $phn
                id_card_photo_url = $ktpUrl
                photo_url         = $selfie
            }
            $vrot = ($p + $b + $t) % 3
            if ($vrot -eq 0) { $v["vendor_id"] = $vendor1.id }
            elseif ($vrot -eq 1) { $v["vendor_id"] = $vendor2.id }
            $visitors += $v
            $seq++
        }

        $pids = @($purposes[($p + $b) % $purposes.Count].id)
        if ((($p + $b) % 2) -eq 1) { $pids += $purposes[($p + $b + 3) % $purposes.Count].id }

        $createBody = @{
            location_id           = $loc.id
            purpose_ids           = $pids
            start_date            = (Iso $start)
            end_date              = (Iso $end)
            is_nda_accepted       = $true
            assignment_letter_url = $letterUrl
            notes                 = "[DUMMY-DEMO] {0} oleh {1} di {2} ({3})" -f $purposes[($p + $b) % $purposes.Count].name, $vendorEmail, $loc.name, $final
            visitors              = $visitors
        }
        $c = Invoke-Api -Method POST -Path "/visits" -Headers (Auth $vendorTok) -Body $createBody
        if ($c.Status -ne 201) {
            Note-Fail "create ($vendorEmail @ $($loc.name))" "HTTP $($c.Status) $($c.Raw)"
            continue
        }
        $vid = $c.Body.data.id
        $vcode = $c.Body.data.visit_id
        $createdIds.Add($vid) | Out-Null
        $createdCodes.Add($vcode) | Out-Null
        $createdBranch[$vid] = $loc.name
        $createdVendor[$vid] = $vendorEmail
        $plannedStatus[$vid] = $final
        $countVendor++

        $adminTok = $adminTokens[$loc.id]
        $secTok = $secTokens[$loc.id]
        if ($final -eq "rejected") {
            $rj = Invoke-Api -Method POST -Path "/visits/$vid/reject" -Headers (Auth $adminTok) `
                -Body @{ reason = "[DUMMY-DEMO] Dokumen SPK kurang lengkap, mohon dilengkapi ulang" }
            if ($rj.Status -ne 200) { Note-Fail "reject $vcode" "HTTP $($rj.Status) $($rj.Raw)" }
            else { $countAdminReject++ }
        } elseif ($final -ne "requested") {
            # requested stays requested: no approval call, no lifecycle (RBAC spot uses these).
            $approver = $adminTok
            $bySuper = $false
            if ($superRemaining -gt 0) {
                $approver = $saToken
                $bySuper = $true
            }
            $ap = Invoke-Api -Method POST -Path "/visits/$vid/approve" -Headers (Auth $approver) `
                -Body @{ notes = "[DUMMY-DEMO] disetujui koordinator $($loc.name)" }
            if ($ap.Status -ne 200) {
                Note-Fail "approve $vcode" "HTTP $($ap.Status) $($ap.Raw)"
                continue
            }
            if ($bySuper) { $countSuperApprove++; $superRemaining-- } else { $countAdminApprove++ }

            if ($final -eq "visiting" -or $final -eq "completed") {
                $ci = Invoke-Api -Method POST -Path "/visits/$vid/checkin" -Headers (Auth $secTok) `
                    -Body @{ notes = "[DUMMY-DEMO] check-in pos $($loc.name)" }
                if ($ci.Status -ne 200) { Note-Fail "checkin $vcode" "HTTP $($ci.Status) $($ci.Raw)"; continue }
                $countSecIn++
                if ($final -eq "completed") {
                    $co = Invoke-Api -Method POST -Path "/visits/$vid/checkout" -Headers (Auth $secTok)
                    if ($co.Status -ne 200) { Note-Fail "checkout $vcode" "HTTP $($co.Status) $($co.Raw)" }
                    else { $countSecOut++ }
                }
            }
        }
        Write-Log ("  {0,-14} vendor={1,-15} branch={2,-28} -> {3}" -f $vcode, $vendorEmail, $loc.name, $final)
    }
}

Write-Log ""
Write-Log ("created: {0} visits filed by vendors (admin/security/superadmin filed 0)" -f $countVendor)

# ------------------------------------------------------- RBAC + detail spot
$rbacOk = $false
$reqVisit = $null
foreach ($id in $createdIds) {
    if ($plannedStatus[$id] -eq "requested") { $reqVisit = $id; break }
}
if ($reqVisit) {
    $ownBranch = $createdBranch[$reqVisit]
    $otherLoc = @($locations | Where-Object { $_.name -ne $ownBranch })[0]
    $x = Invoke-Api -Method POST -Path "/visits/$reqVisit/approve" -Headers (Auth $adminTokens[$otherLoc.id]) -Body @{ notes = "cross branch" }
    if ($x.Status -eq 403) { $rbacOk = $true }
    else { Note-Fail "RBAC cross-branch approve" "expected 403, got HTTP $($x.Status) $($x.Raw)" }
    Write-Log ("RBAC spot: admin cabang lain approve -> HTTP {0} (expect 403)" -f $x.Status)
}

$spotOk = $false
$spotVisit = $null
foreach ($id in $createdIds) {
    if ($plannedStatus[$id] -eq "completed") { $spotVisit = $id; break }
}
if ($spotVisit) {
    $d = Invoke-Api -Path "/visits/$spotVisit" -Headers (Auth $saToken)
    if ($d.Status -eq 200) {
        $vv = $d.Body.data.visitors[0]
        Write-Log ("detail spot: code={0} vendor_name(visit)='{1}' vendor_name(tech)='{2}' photo_url='{3}'" -f $d.Body.data.visit_id, $d.Body.data.vendor_name, $vv.vendor_name, $vv.photo_url)
        if ($vv.photo_url) { $spotOk = $true } else { Note-Fail "detail spot" "photo_url empty" }
    } else { Note-Fail "detail spot" "HTTP $($d.Status)" }
}
$spotVisit2 = $null
foreach ($id in $createdIds) {
    if ($plannedStatus[$id] -eq "visiting" -and $id -ne $spotVisit) { $spotVisit2 = $id; break }
}
if ($spotVisit2) {
    $d2 = Invoke-Api -Path "/visits/$spotVisit2" -Headers (Auth $saToken)
    if ($d2.Status -eq 200) {
        $w = $d2.Body.data.visitors[0]
        Write-Log ("detail spot: code={0} vendor_name(visit)='{1}' vendor_name(tech)='{2}' photo_url='{3}'" -f $d2.Body.data.visit_id, $d2.Body.data.vendor_name, $w.vendor_name, $w.photo_url)
    }
}

# ------------------------------------------------------------------ report
$all = Invoke-Api -Path "/visits?limit=100" -Headers (Auth $saToken)
$demo = @()
if ($all.Status -eq 200) {
    $demo = @($all.Body.data.items | Where-Object { $_.notes -like '`[DUMMY-DEMO`]*' })
}

Write-Log ""
Write-Log "================ PER-BRANCH (expect 10 each) ================"
$locNameById = @{}
foreach ($l in $locations) { $locNameById[$l.id] = $l.name }
$byBranch = @{}
foreach ($v in $demo) {
    # List items embed only location.id (detail embeds the full object).
    $bn = $locNameById[$v.location.id]
    if (-not $bn) { $bn = "(unknown branch)" }
    if (-not $byBranch.ContainsKey($bn)) { $byBranch[$bn] = 0 }
    $byBranch[$bn]++
}
foreach ($l in $locations) {
    $n = 0
    if ($byBranch.ContainsKey($l.name)) { $n = $byBranch[$l.name] }
    $flag = ""
    if ($n -ne 10) { $flag = "  << EXPECTED 10"; Note-Fail "branch count $($l.name)" "got $n" }
    Write-Log ("  {0,-32} : {1}{2}" -f $l.name, $n, $flag)
}

Write-Log "================ PER-STATUS ================"
$byStatus = @{}
foreach ($v in $demo) {
    if (-not $byStatus.ContainsKey($v.status)) { $byStatus[$v.status] = 0 }
    $byStatus[$v.status]++
}
foreach ($s in @("requested", "approved", "visiting", "completed", "rejected")) {
    $n = 0
    if ($byStatus.ContainsKey($s)) { $n = $byStatus[$s] }
    Write-Log ("  {0,-12} : {1}" -f $s, $n)
}
$rejN = 0
if ($byStatus.ContainsKey("rejected")) { $rejN = $byStatus["rejected"] }
if ($rejN -lt 5 -or $rejN -gt 7) { Note-Fail "rejected count" "got $rejN, expected ~6" }

Write-Log "================ PER-ROLE (actions this run) ================"
Write-Log ("  vendor       : {0} visits filed (10 vendors x 5 branches; other roles filed 0)" -f $countVendor)
Write-Log ("  admin        : {0} approvals + {1} rejections (branch koordinator)" -f $countAdminApprove, $countAdminReject)
Write-Log ("  security     : {0} check-ins + {1} check-outs (branch pengawas)" -f $countSecIn, $countSecOut)
Write-Log ("  super_admin  : {0} approvals (HQ) + discovery/uploads" -f $countSuperApprove)
if ($countVendor -ne 50) { Note-Fail "vendor filed count" "got $countVendor" }
if ($countSuperApprove -ne 2) { Note-Fail "superadmin approvals" "got $countSuperApprove, expected 2" }
if (-not $rbacOk) { Note-Fail "RBAC spot" "cross-branch approve was not 403" }
if (-not $spotOk) { Note-Fail "detail spot" "photo_url missing" }

Write-Log ""
Write-Log "=============================================================="
Write-Log (" demo visits in DB this run: {0}   (server total items seen: {1})" -f $demo.Count, $all.Body.data.total)
Write-Log (" FAILURES: {0}" -f $script:Fail)
foreach ($f in $script:Failures) { Write-Log ("  " + $f) }
Write-Log " DB left as-is: the seeded rows ARE the deliverable."
Write-Log "=============================================================="
if ($script:Fail -gt 0) { exit 1 }
