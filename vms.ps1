<#
.SYNOPSIS
One dispatcher for the whole THC-VMS local stack: PostgreSQL + MinIO (docker),
the Go backend, and the Next.js frontend.

.DESCRIPTION
Usage:
    vms <target> <action> [ports...] [-Force]

  target : be | fe | docker | port | vms (alias: all)
  action : start | stop | restart | status | logs
           (docker also accepts: reset   -> down -v, DESTROYS all data)
           (port also accepts:   list | kill | proxy [list, read-only])

  A single word that names an action is shorthand for the whole stack, so
  `vms start` and `vms vms start` are the same command.

  Examples:
    vms docker start        # PostgreSQL + MinIO only
    vms be start            # backend only (assumes docker is already up)
    vms fe start            # frontend only (defaults to port 3210)
    vms fe start 4000       # frontend on a specific port
    vms start               # EVERYTHING, in dependency order: docker -> be -> fe
    vms stop                # stop everything (fe -> be -> docker)
    vms status              # one screen showing every component
    vms be logs             # tail the backend log
    vms be foreground       # run the backend in THIS terminal (Ctrl+C = graceful)
    vms port list           # who is holding each project port
    vms port kill           # free 8080 + 3210 (asks first)
    vms port kill -Force    # free them without the prompt
    vms port kill 3210      # free one specific port

  This script never edits Windows system configuration. It reports what holds a
  port (including netsh portproxy rules) and suggests another port, but it does
  not add or delete anything under HKLM or run elevated netsh.

Design notes:
  * Nothing here is destructive by default. `docker reset` is the only command
    that deletes data and it asks for confirmation.
  * State lives in .runtime/ at the repo root (pids + logs), which is
    gitignored, so a stop always finds the process it started.
  * `be stop` is a hard terminate (Windows has no easy way to deliver SIGINT to
    a detached process). Use `be foreground` when you want the graceful
    shutdown path that cmd/server/main.go implements.
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)][string]$Target = "vms",
    [Parameter(Position = 1)][string]$Action = "status",
    # Everything after "<target> <action>": port numbers and switches, so
    # `vms port kill 8080 3000 -Force` and `vms port kill -Force` both work.
    [Parameter(Position = 2, ValueFromRemainingArguments = $true)][string[]]$Rest
)

$ErrorActionPreference = 'Stop'
# This script lives at the repository root, so $PSScriptRoot IS the root. Taking
# its parent would point one level above the project and silently break compose.
$RepoRoot = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$Runtime = Join-Path $RepoRoot ".runtime"
$Backend = Join-Path $RepoRoot "backend"
$Frontend = Join-Path $RepoRoot "frontend"

# Port map is the single source of truth for "is it listening".
# fe is 3210, not the Next.js default 3000: a stale netsh portproxy rule (IP
# Helper) permanently binds 0.0.0.0:3000 on this machine. frontend/package.json
# pins the same port, so `npm run dev` and `vms fe status` agree. Changing
# Windows config is deliberately out of scope for this script.
$Ports = @{ docker = @(5432, 9000, 9001); be = @(8080); fe = @(3210) }

function New-Runtime {
    if (-not (Test-Path -LiteralPath $Runtime)) {
        New-Item -ItemType Directory -Path $Runtime -Force | Out-Null
    }
}

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "    OK   $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "    WARN $msg" -ForegroundColor Yellow }
function Write-Err2($msg) { Write-Host "    FAIL $msg" -ForegroundColor Red }
function Write-Info($msg) { Write-Host "    $msg" }

function Get-PidFile([string]$name) { return (Join-Path $Runtime "$name.pid") }
function Get-PortFile([string]$name) { return (Join-Path $Runtime "$name.port") }
function Get-LogFile([string]$name) { return (Join-Path $Runtime "$name.log") }
function Get-ErrFile([string]$name) { return (Join-Path $Runtime "$name.err.log") }

# Get-TrackedPid returns the live PID recorded for a component, or $null when the
# component is not running. A stale pid file is cleaned up rather than trusted.
function Get-TrackedPid([string]$name) {
    $file = Get-PidFile $name
    if (-not (Test-Path -LiteralPath $file)) { return $null }
    $raw = (Get-Content -LiteralPath $file -Raw).Trim()
    if (-not $raw) { return $null }
    $id = 0
    if (-not [int]::TryParse($raw, [ref]$id)) { return $null }
    if (Get-Process -Id $id -ErrorAction SilentlyContinue) { return $id }
    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    return $null
}

function Test-PortBusy([int]$port) {
    return [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
}

# Wait-HttpOk polls a URL until it answers 2xx or the budget runs out.
function Wait-HttpOk([string]$url, [int]$seconds = 45) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
            if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300) { return $true }
        } catch { }
        Start-Sleep -Milliseconds 700
    }
    return $false
}

# ============================================================== DOCKER
# docker compose reports informational notes (for example "the attribute
# `version` is obsolete") on stderr. Under $ErrorActionPreference = 'Stop' the
# 2>&1 redirect promotes those to terminating NativeCommandError records, which
# kills the function before the actual output is ever printed. Scope the
# preference to Continue around the call instead of relaxing it repo-wide, and
# hand the caller the real exit code so failures are still detected.
function Invoke-Docker([string[]]$DockerArgs) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        Push-Location $RepoRoot
        try { & docker @DockerArgs 2>&1 | ForEach-Object { Write-Info $_ } }
        finally { Pop-Location }
        return $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $prev }
}

function Docker-Start {
    Write-Step "docker: starting PostgreSQL + MinIO"
    # postgres:18-alpine refuses to boot with the volume on the old
    # /var/lib/postgresql/data path, so the compose file in the repo root is
    # the corrected one; never regenerate it from the docs snippet.
    if ((Invoke-Docker @("compose", "up", "-d")) -ne 0) {
        Write-Err2 "docker compose up failed"
        return $false
    }

    $ok = $true
    foreach ($p in $Ports.docker) {
        $deadline = (Get-Date).AddSeconds(90)
        while ((Get-Date) -lt $deadline -and -not (Test-PortBusy $p)) { Start-Sleep -Seconds 2 }
        if (Test-PortBusy $p) { Write-Ok "port $p listening" } else { Write-Warn2 "port $p not listening yet"; $ok = $false }
    }
    Invoke-Docker @("compose", "ps", "--format", "{{.Name}}|{{.Status}}") | Out-Null
    return $ok
}

function Docker-Stop {
    Write-Step "docker: stopping PostgreSQL + MinIO (volumes are KEPT)"
    Invoke-Docker @("compose", "stop") | Out-Null
    Write-Ok "containers stopped; data volumes preserved"
}

function Docker-Reset {
    Write-Step "docker: destroying containers AND data volumes"
    Write-Warn2 "This deletes the entire database, including every seeded and QA row."
    $answer = Read-Host "    Type 'reset' to confirm"
    if ($answer -ne "reset") { Write-Info "aborted"; return }
    Invoke-Docker @("compose", "down", "-v") | Out-Null
    Write-Ok "volumes removed"
}

function Docker-Status {
    Write-Step "docker: PostgreSQL + MinIO"
    Invoke-Docker @("compose", "ps", "--format", "{{.Name}} | {{.Image}} | {{.Status}}") | Out-Null
    foreach ($p in $Ports.docker) {
        if (Test-PortBusy $p) { Write-Ok "port $p listening" } else { Write-Warn2 "port $p free" }
    }
}

function Docker-Logs {
    Write-Step "docker: recent logs"
    Invoke-Docker @("compose", "logs", "--tail", "60") | Out-Null
}

# ================================================================ BE
function Be-Build {
    Write-Step "be: compiling the server binary"
    $bin = Join-Path $Runtime "thc-server.exe"
    Push-Location $Backend
    try {
        & go build -o $bin ./cmd/server 2>&1 | ForEach-Object { Write-Info $_ }
        if ($LASTEXITCODE -ne 0) { Write-Err2 "go build failed"; return $null }
    } finally { Pop-Location }
    Write-Ok "built $bin"
    return $bin
}

function Be-Start {
    $existing = Get-TrackedPid "be"
    if ($existing) { Write-Warn2 "backend already running (PID $existing)"; return }
    if (-not (Test-Path -LiteralPath (Join-Path $Backend ".env"))) {
        Write-Warn2 "backend/.env is missing; the server refuses to start without JWT_SECRET and DB credentials"
        Write-Info "create it with: Copy-Item .env.example .env"
        return
    }
    $bin = Be-Build
    if (-not $bin) { return }

    Write-Step "be: starting on port 8080"
    New-Runtime
    $p = Start-Process -FilePath $bin -WorkingDirectory $Backend `
        -RedirectStandardOutput (Get-LogFile "be") -RedirectStandardError (Get-ErrFile "be") `
        -PassThru -WindowStyle Hidden
    $p.Id | Set-Content -LiteralPath (Get-PidFile "be")

    if (Wait-HttpOk "http://localhost:8080/api/v1/health" 45) {
        Write-Ok "backend healthy (PID $($p.Id))"
        Write-Info "health : http://localhost:8080/api/v1/health"
        Write-Info "ready  : http://localhost:8080/api/v1/ready"
        Write-Info "api    : http://localhost:8080/api/v1"
    } else {
        Write-Err2 "backend did not become healthy in time; last log lines:"
        if (Test-Path (Get-ErrFile "be")) { Get-Content (Get-ErrFile "be") -Tail 20 | ForEach-Object { Write-Info $_ } }
    }
    Write-Warn2 "login is rate limited to 5 attempts/min/IP; set `$env:AUTH_RATE_LIMIT=500 for load or QA runs"
}

function Be-Stop {
    $id = Get-TrackedPid "be"
    if (-not $id) { Write-Warn2 "backend is not running"; return }
    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 800
    if (Get-Process -Id $id -ErrorAction SilentlyContinue) { Write-Err2 "PID $id would not die" }
    else { Write-Ok "backend stopped (was PID $id)"; Write-Info "this is a hard terminate; use 'vms be foreground' for the graceful path" }
}

function Be-Foreground {
    Write-Step "be: running in this terminal; press Ctrl+C for graceful shutdown"
    if (-not (Test-Path -LiteralPath (Join-Path $Backend ".env"))) {
        Write-Err2 "backend/.env is missing"; return
    }
    Push-Location $Backend
    try { & go run ./cmd/server } finally { Pop-Location }
}

function Be-Status {
    Write-Step "be: backend"
    $id = Get-TrackedPid "be"
    if ($id) { Write-Ok "running (PID $id)" } else { Write-Warn2 "not running" }
    if (Test-PortBusy 8080) { Write-Ok "port 8080 listening" } else { Write-Warn2 "port 8080 free" }
    try {
        $h = Invoke-RestMethod "http://localhost:8080/api/v1/health" -TimeoutSec 3
        Write-Info ("health: " + ($h | ConvertTo-Json -Compress))
        $r = Invoke-RestMethod "http://localhost:8080/api/v1/ready" -TimeoutSec 3
        Write-Info ("ready : " + ($r | ConvertTo-Json -Compress))
    } catch { Write-Info "health endpoint not answering" }
}

function Be-Logs {
    $f = Get-ErrFile "be"
    if (-not (Test-Path $f)) { Write-Warn2 "no backend log yet"; return }
    Write-Step "be: log tail"
    Get-Content $f -Tail 60 | ForEach-Object { Write-Info $_ }
}

# ================================================================ FE
function Test-FrontendPresent {
    if (-not (Test-Path -LiteralPath $Frontend)) {
        Write-Warn2 "frontend/ does not exist in this repository yet"
        Write-Info "the backend agent does not build the frontend; create it with: npx create-next-app@latest frontend"
        return $false
    }
    return $true
}

# Get-FePort resolves which port the frontend uses.
#   * An explicit argument always wins.
#   * For 'start', the port map is the default, so a port recorded by an older
#     run can never silently override the configured one. The map is truth for
#     what to launch; the recorded file is only history of what did run.
#   * For 'status' and 'port list', the recorded file wins because it describes
#     the process that is actually alive right now.
function Get-FePort([string]$Requested, [switch]$PreferRecorded) {
    if ($Requested) {
        $n = 0
        if ($Requested -match '^\d+$' -and [int]::TryParse($Requested, [ref]$n)) { return $n }
    }
    if ($PreferRecorded) {
        $saved = Get-Content -LiteralPath (Get-PortFile "fe") -Raw -ErrorAction SilentlyContinue
        if ($saved) {
            $n = 0
            if ([int]::TryParse($saved.Trim(), [ref]$n)) { return $n }
        }
    }
    return $Ports.fe[0]
}

# Get-NextFreePorts offers usable alternatives when the wanted port is taken,
# so a busy port never becomes a dead end.
function Get-NextFreePorts([int]$After, [int]$Count = 3) {
    $found = @()
    for ($p = $After + 1; $p -le $After + 50 -and $found.Count -lt $Count; $p++) {
        if (-not (Test-PortBusy $p)) { $found += $p }
    }
    return $found
}

function Fe-Start([string]$PortWanted) {
    if (-not (Test-FrontendPresent)) { return }
    $port = Get-FePort $PortWanted
    $existing = Get-TrackedPid "fe"
    if ($existing) { Write-Warn2 "frontend already running (PID $existing) on port $port"; return }
    if (Test-PortBusy $port) {
        Write-Err2 "port $port is already in use; not starting the frontend there"
        $owner = Get-PortOwner $port
        if ($owner) {
            if (Test-ProtectedProcess $owner.Pid $owner.Name) {
                $rule = Get-PortProxyRule $port
                Write-Info "  holder: $($owner.Name) (PID $($owner.Pid)), a Windows system process - left untouched"
                if ($rule) { Write-Info "  cause: netsh portproxy rule $rule" }
            } else {
                Write-Info "  holder: $($owner.Name) (PID $($owner.Pid))"
            }
        }
        # Picking another port needs no Windows changes at all, so offer it.
        $alt = Get-NextFreePorts $port 3
        if ($alt) {
            Write-Info "free alternatives: $($alt -join ', ')"
            Write-Info "run: vms fe start $($alt[0])"
        }
        return
    }
    Write-Step "fe: starting Next.js on port $port"
    New-Runtime
    $npm = if (Get-Command npm.cmd -ErrorAction SilentlyContinue) { "npm.cmd" } else { "npm" }
    # $npmArgs, not $args: the latter is an automatic variable.
    $npmArgs = @("run", "dev", "--", "-p", "$port")
    $p = Start-Process -FilePath $npm -ArgumentList $npmArgs -WorkingDirectory $Frontend `
        -RedirectStandardOutput (Get-LogFile "fe") -RedirectStandardError (Get-ErrFile "fe") `
        -PassThru -WindowStyle Hidden
    $p.Id | Set-Content -LiteralPath (Get-PidFile "fe")
    "$port" | Set-Content -LiteralPath (Get-PortFile "fe")
    # Next.js reports "Ready" in under a second, but it compiles the first route
    # only when that route is requested. The probe below is what triggers that
    # compile, so the wait is a dev build, not a slow start. Saying so up front
    # keeps it from looking like the script is hung.
    Write-Info "waiting for the first response; Next.js compiles the first route on request, which takes a few seconds"
    if (Wait-HttpOk "http://localhost:$port" 60) {
        Write-Ok "frontend up (PID $($p.Id)) - http://localhost:$port"
    } else {
        Write-Warn2 "frontend did not answer in 60s; check 'vms fe logs'"
        Write-Info "or run it yourself for live output: cd frontend; npm run dev"
    }
}

function Fe-Stop {
    $id = Get-TrackedPid "fe"
    if (-not $id) { Write-Warn2 "frontend is not running"; return }
    # next dev spawns a child; kill the tree so no orphan node process survives.
    & taskkill /PID $id /T /F 2>&1 | ForEach-Object { Write-Info $_ }
    Write-Ok "frontend stopped"
}

function Fe-Status {
    Write-Step "fe: frontend"
    if (-not (Test-Path -LiteralPath $Frontend)) { Write-Warn2 "frontend/ does not exist yet"; return }
    $id = Get-TrackedPid "fe"
    $port = Get-FePort "" -PreferRecorded
    if (-not $id) {
        Write-Warn2 "not running (last requested port: $port)"
        return
    }
    Write-Ok "running (PID $id) on port $port"
    if (Test-PortBusy $port) { Write-Ok "port $port listening" }
    else { Write-Warn2 "port $port is NOT listening (expected http://localhost:$port)" }
}

function Fe-Logs {
    $f = Get-ErrFile "fe"
    if (-not (Test-Path $f)) { Write-Warn2 "no frontend log yet"; return }
    Write-Step "fe: log tail"
    Get-Content $f -Tail 60 | ForEach-Object { Write-Info $_ }
}

# ================================================================ PORT
# Frees a project port when something else squats on it. Two kinds of port live
# in this project and they must be released differently:
#
#   8080 / 3210  owned by a real process (thc-server.exe, node). Safe to kill.
#   5432 / 9000 / 9001  published by Docker Desktop. On Windows the listening
#                        socket belongs to the Docker relay, NOT to a container
#                        process, so taskkill would break every other container
#                        on the machine. These are freed with `vms docker stop`.
$AppPorts = @(8080, $Ports.fe[0])

# Windows processes that must never be taskkilled, no matter what. svchost is
# the dangerous one: a single instance can host a dozen critical services, so
# killing it to free a port can take down WMI, Task Scheduler, SMB, and the
# desktop session with it. The rest are equally unrecoverable from a script.
$ProtectedProcesses = @(
    "system", "idle", "registry", "memory compression",
    "smss", "csrss", "wininit", "winlogon", "lsass", "lsaiso",
    "svchost", "services", "dwm", "fontdrvhost", "spoolsv",
    "msmpeng", "securityhealthservice", "securityhealthsystray", "explorer"
)

# Get-HostedServiceNames lists the Windows services running inside a PID. Any
# PID that hosts a service is treated as protected, which covers cases the name
# blocklist cannot see (a service binary that is not svchost).
function Get-HostedServiceNames([int]$ProcId) {
    $svcs = Get-CimInstance -ClassName Win32_Service -Filter "ProcessId=$ProcId" -ErrorAction SilentlyContinue
    if (-not $svcs) { return @() }
    return @($svcs | ForEach-Object { $_.Name })
}

function Test-ProtectedProcess([int]$ProcId, [string]$ProcName) {
    if ($ProcName -and $ProcName.ToLower() -in $ProtectedProcesses) { return $true }
    return ((Get-HostedServiceNames $ProcId).Count -gt 0)
}

# Get-PortProxyRule reports the netsh portproxy listen rule bound to a port.
# Parsing is positional, not by header text, so it survives a localised netsh.
function Get-PortProxyRule([int]$Port) {
    $raw = (& netsh interface portproxy show all 2>$null | Out-String)
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    foreach ($line in ($raw -split "`r?`n")) {
        $parts = @($line -split '\s+' | Where-Object { $_ })
        # Columns: ListenAddress ListenPort ConnectAddress ConnectPort
        if ($parts.Count -ge 4 -and $parts[1] -eq "$Port") {
            return "$($parts[0]):$($parts[1])  ->  $($parts[2]):$($parts[3])"
        }
    }
    return $null
}

# Get-PortOwner returns the process listening on a port, or $null when free.
function Get-PortOwner([int]$Port) {
    $conn = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $conn) { return $null }
    $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    return [pscustomobject]@{
        Port = $Port
        Pid  = $conn.OwningProcess
        Name = $(if ($proc) { $proc.ProcessName } else { "<exited>" })
    }
}

# Test-PidDescendsFrom walks the parent chain to decide whether a port owner is
# really one of ours. `npm run dev` records npm's PID but the listener is the
# `next dev` child, so a plain PID comparison would mislabel it as FOREIGN.
function Test-PidDescendsFrom([int]$ProcId, [int]$AncestorId) {
    $current = $ProcId
    # Bounded on purpose: bad data must not spin forever.
    for ($hop = 0; $hop -lt 12; $hop++) {
        if ($current -eq $AncestorId) { return $true }
        $c = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$current" -ErrorAction SilentlyContinue
        if (-not $c -or -not $c.ParentProcessId -or $c.ParentProcessId -eq 0) { return $false }
        $current = [int]$c.ParentProcessId
    }
    return $false
}

# Get-TrackedComponentForPid maps a port owner back to the vms component that
# started it ("be" or "fe"), or $null when the process is foreign.
function Get-TrackedComponentForPid([int]$ProcId) {
    foreach ($name in @("be", "fe")) {
        $tracked = Get-TrackedPid $name
        if ($tracked -and (Test-PidDescendsFrom $ProcId $tracked)) { return $name }
    }
    return $null
}

function Write-PortRow([string]$Port, [string]$ProcId, [string]$ProcName, [string]$Owner, [string]$Color) {
    Write-Host ("    {0,-6} {1,-8} {2,-20} {3}" -f $Port, $ProcId, $ProcName, $Owner) -ForegroundColor $Color
}

function Port-List {
    Write-Step "port: project port map"
    $groups = @(
        @("be", $Ports.be),
        @("fe", @((Get-FePort "" -PreferRecorded))),
        @("docker", $Ports.docker)
    )
    foreach ($group in $groups) {
        $kind = $group[0]
        foreach ($port in $group[1]) {
            $owner = Get-PortOwner $port
            if (-not $owner) {
                Write-PortRow $port "-" "-" "free" 'DarkGray'
                continue
            }
            $component = Get-TrackedComponentForPid $owner.Pid
            if ($component) {
                Write-PortRow $port $owner.Pid $owner.Name "vms $component" 'Green'
            }
            elseif ($kind -eq "docker") {
                Write-PortRow $port $owner.Pid $owner.Name "docker -> vms docker stop" 'Yellow'
            }
            elseif (Test-ProtectedProcess $owner.Pid $owner.Name) {
                $rule = Get-PortProxyRule $port
                $why = if ($rule) { "SYSTEM portproxy (PROTECTED)" } else { "SYSTEM process (PROTECTED)" }
                Write-PortRow $port $owner.Pid $owner.Name $why 'Yellow'
            }
            else {
                Write-PortRow $port $owner.Pid $owner.Name "FOREIGN -> vms port kill $port" 'Red'
            }
        }
    }
}

function Port-Kill([string[]]$Words) {
    $requested = @()
    $force = $false
    foreach ($w in $Words) {
        if ($w -in @("-Force", "--force", "-f")) { $force = $true }
        elseif ($w -match '^\d+$') { $requested += [int]$w }
        elseif ($w) { Write-Err2 "unexpected argument '$w' (expected a port number or -Force)"; return }
    }

    $targets = if ($requested) { $requested } else { $AppPorts }

    $killable = @()
    $proxyPorts = @()

    foreach ($port in ($targets | Select-Object -Unique)) {
        # Docker ports are released by stopping containers, never by taskkill.
        if ($port -in $Ports.docker) {
            Write-Warn2 "port $port belongs to the Docker Desktop proxy, not to a killable project process."
            Write-Info "run 'vms docker stop' instead: it frees the ports and keeps the data volumes."
            continue
        }

        $owner = Get-PortOwner $port
        if (-not $owner) { Write-Ok "port $port is already free"; continue }

        # Hard stop for anything Windows owns. Killing a service host to free a
        # dev port is never the right trade, so report and refuse instead.
        if (Test-ProtectedProcess $owner.Pid $owner.Name) {
            Write-Warn2 "port $port is held by a PROTECTED Windows process: $($owner.Name) (PID $($owner.Pid)) - not killing it"
            $svcs = Get-HostedServiceNames $owner.Pid
            if ($svcs) {
                $shown = @($svcs | Select-Object -First 8)
                $more = if ($svcs.Count -gt $shown.Count) { " (+$($svcs.Count - $shown.Count) more)" } else { "" }
                Write-Info "  it hosts $($svcs.Count) service(s): $($shown -join ', ')$more"
            }
            $rule = Get-PortProxyRule $port
            if ($rule) {
                Write-Info "  this is a netsh portproxy forward you created: $rule"
                $proxyPorts += $port
            } else {
                Write-Info "  no portproxy rule found. Free the port from whatever app or service opened it."
            }
            continue
        }

        $component = Get-TrackedComponentForPid $owner.Pid
        # Prefer the tracked root PID so the whole tree dies; npm would survive
        # a kill aimed only at its `next dev` child.
        $killPid = if ($component) { Get-TrackedPid $component } else { $owner.Pid }
        $killable += [pscustomobject]@{
            Port      = $port
            OwnerPid  = $owner.Pid
            Name      = $owner.Name
            Component = $component
            KillPid   = $killPid
        }
    }

    if (-not $killable -and -not $proxyPorts) { return }

    if ($killable) {
        Write-Step "port: $($killable.Count) killable port(s)"
        foreach ($v in $killable) {
            $origin = if ($v.Component) { "ours, tracked as '$($v.Component)' (PID $($v.KillPid))" }
                      else { "FOREIGN, this script did not start it (PID $($v.KillPid))" }
            Write-Info "port $($v.Port) <- $($v.Name) [$origin]"
        }
    }
    if ($proxyPorts) {
        Write-Step "port: $($proxyPorts.Count) netsh portproxy rule(s) to remove"
        foreach ($p in $proxyPorts) { Write-Info "port $p -> $(Get-PortProxyRule $p)" }
    }

    if (-not $force) {
        $parts = @()
        if ($killable) { $parts += "terminate $($killable.Count) process tree(s)" }
        if ($proxyPorts) { $parts += "remove $($proxyPorts.Count) portproxy rule(s)" }
        Write-Warn2 "This will $($parts -join ' and ')."
        $answer = Read-Host "    Type 'kill' to proceed"
        if ($answer -ne "kill") { Write-Info "aborted"; return }
    }

    foreach ($v in $killable) {
        & taskkill /PID $v.KillPid /T /F 2>&1 | ForEach-Object { Write-Info $_ }
        if ($v.Component) {
            Remove-Item -LiteralPath (Get-PidFile $v.Component) -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Milliseconds 600
        if (Test-PortBusy $v.Port) {
            Write-Warn2 "port $($v.Port) is STILL bound after the kill; something else grabbed it"
        } else {
            $tail = if ($v.Component) { " (cleared .runtime/$($v.Component).pid)" } else { "" }
            Write-Ok "port $($v.Port) is free$tail"
        }
    }
    if ($proxyPorts) {
        # Reported, never removed. Touching a portproxy rule means editing
        # Windows system config, which this script refuses to do. Free the port
        # from the other side instead: 'vms fe start <port>'.
        Write-Warn2 "port $($proxyPorts -join ', ') still held by a portproxy rule. This script does not change Windows config."
        Write-Info "use a different port instead: vms fe start <port>"
    }
}

# Port-Proxy is READ-ONLY on purpose. Netsh portproxy rules are the usual
# reason a port is unexpectedly taken, and diagnosing that is useful, but
# editing them means mutating Windows system configuration. That decision
# belongs to a human at an elevated prompt, never to this script.
function Port-Proxy {
    Write-Step "port: netsh portproxy rules (read-only)"
    $raw = (& netsh interface portproxy show all 2>$null | Out-String)
    if ([string]::IsNullOrWhiteSpace($raw) -or $raw -notmatch '\d+\s+\d+') {
        Write-Info "no portproxy rules are configured"
        return
    }
    Write-Info $raw.Trim()
    Write-Info "these rules live in HKLM and survive reboots; a dead target still holds the port."
    Write-Info "this script will not add or delete them. Free the port by using a different one."
}

# ============================================================== ALL
function All-Start {
    Write-Host ""
    Write-Host "### starting the whole THC-VMS stack ###" -ForegroundColor Magenta
    if (Docker-Start) { Write-Ok "infrastructure ready" } else { Write-Warn2 "infrastructure incomplete; the backend will likely fail to connect" }
    Be-Start
    Fe-Start
    Write-Host ""
    Write-Host "### done. status: vms status ###" -ForegroundColor Magenta
}

function All-Stop {
    Write-Host ""
    Write-Host "### stopping the whole THC-VMS stack ###" -ForegroundColor Magenta
    Fe-Stop
    Be-Stop
    Docker-Stop
    Write-Host ""
    Write-Host "### stopped. data volumes were preserved. ###" -ForegroundColor Magenta
}

function All-Status {
    Write-Host ""
    Write-Host "### THC-VMS local status ###" -ForegroundColor Magenta
    Docker-Status
    Write-Host ""
    Be-Status
    Write-Host ""
    Fe-Status
    Write-Host ""
}

# ============================================================== dispatch
New-Runtime
$target = $Target.ToLower()
$action = $Action.ToLower()

# Bare `vms` with no arguments is a request for orientation, not a status poll.
if ($PSBoundParameters.Count -eq 0) {
    $target = "help"
    $action = ""
}
# `vms start` must mean "the whole stack", not "unknown target 'start'". Only
# shift when no action was typed, so `vms be start` and `vms docker status`
# keep their explicit target.
elseif (-not $PSBoundParameters.ContainsKey('Action') -and
        $target -in @("start", "stop", "restart", "status", "logs")) {
    $action = $target
    $target = "vms"
}

switch ($target) {
    "help" {
        Write-Host ""
        Write-Host "vms <target> <action>" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "  targets : be | fe | docker | port | vms (alias: all)" -ForegroundColor Gray
        Write-Host "  actions : start | stop | restart | status | logs" -ForegroundColor Gray
        Write-Host "  extras  : be foreground | be build | docker reset" -ForegroundColor Gray
        Write-Host "            port list | port kill | port proxy (read-only)" -ForegroundColor Gray
        Write-Host "  bare action, e.g. 'vms start', applies to the whole stack" -ForegroundColor DarkGray
        Write-Host ""
        Write-Host "  examples:" -ForegroundColor Gray
        Write-Host "    vms start            # docker + backend + frontend" -ForegroundColor DarkGray
        Write-Host "    vms stop             # frontend + backend + docker" -ForegroundColor DarkGray
        Write-Host "    vms status           # one screen" -ForegroundColor DarkGray
        Write-Host "    vms logs             # docker + backend + frontend logs" -ForegroundColor DarkGray
        Write-Host "    vms be start         # backend only" -ForegroundColor DarkGray
        Write-Host "    vms be stop          # backend only" -ForegroundColor DarkGray
        Write-Host "    vms be foreground    # backend in this terminal, Ctrl+C to stop" -ForegroundColor DarkGray
        Write-Host "    vms docker stop      # database + object storage only" -ForegroundColor DarkGray
        Write-Host "    vms port list        # who holds 8080 / 3210 / 5432 / 9000 / 9001" -ForegroundColor DarkGray
        Write-Host "    vms port kill        # free 8080 + 3210 (asks first, never kills system procs)" -ForegroundColor DarkGray
        Write-Host "    vms port kill -Force # free them with no prompt" -ForegroundColor DarkGray
        Write-Host "    vms fe start 4000    # run the frontend on another port" -ForegroundColor DarkGray
        Write-Host "    vms port proxy       # show netsh portproxy rules (read-only, never edited)" -ForegroundColor DarkGray
        Write-Host ""
    }
    "be" { switch ($action) {
        "start" { Be-Start } "stop" { Be-Stop } "restart" { Be-Stop; Be-Start }
        "status" { Be-Status } "logs" { Be-Logs } "foreground" { Be-Foreground }
        "build" { Be-Build | Out-Null }
        default { Write-Err2 "unknown action '$Action' for be (start|stop|restart|status|logs|foreground|build)" } } }
    "fe" { switch ($action) {
        "start" { Fe-Start ($Rest | Select-Object -First 1) }
        "stop" { Fe-Stop } "restart" { Fe-Stop; Fe-Start ($Rest | Select-Object -First 1) }
        "status" { Fe-Status } "logs" { Fe-Logs }
        default { Write-Err2 "unknown action '$Action' for fe (start|stop|restart|status|logs)" } } }
    "docker" { switch ($action) {
        "start" { Docker-Start | Out-Null } "stop" { Docker-Stop } "restart" { Docker-Stop; Docker-Start | Out-Null }
        "status" { Docker-Status } "logs" { Docker-Logs } "reset" { Docker-Reset }
        default { Write-Err2 "unknown action '$Action' for docker (start|stop|restart|status|logs|reset)" } } }
    "port" { switch ($action) {
        "list" { Port-List } "status" { Port-List } "ls" { Port-List }
        "kill" { Port-Kill $Rest }
        "proxy" { Port-Proxy $Rest }
        default { Write-Err2 "unknown action '$Action' for port (list|kill|proxy)" } } }
    { $_ -in @("vms", "all", "") } { switch ($action) {
        "start" { All-Start } "stop" { All-Stop } "restart" { All-Stop; All-Start }
        "status" { All-Status } "logs" { Docker-Logs; Be-Logs; Fe-Logs }
        default { Write-Err2 "unknown action '$Action' for vms (start|stop|restart|status|logs)" } } }
    default { Write-Err2 "unknown target '$Target' (be | fe | docker | vms | help)"; Write-Info "run 'vms' with no arguments for the command list" }
}
