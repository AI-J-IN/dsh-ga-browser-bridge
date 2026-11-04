<#
.SYNOPSIS
    Create a dedicated Chrome profile for CDP debugging and copy your logins
    into it, then (optionally) launch that Chrome with --remote-debugging-port.

.DESCRIPTION
    Why this exists
    ---------------
    Chrome only opens a remote-debugging port at LAUNCH time, and since
    Chrome 136 it silently ignores --remote-debugging-port on the DEFAULT
    profile (no error, no port, no DevToolsActivePort). So an already-running
    Chrome can never be attached to, and relaunching the default profile does
    not help either. The only supported path is a SEPARATE --user-data-dir.

    A separate profile starts logged out. This script copies the files that
    carry your sessions from your real profile into the new one.

    The one file everyone misses is `Local State` (at the User Data root):
    Chrome encrypts cookies with Windows DPAPI and keeps the key there.
    Copy Network\Cookies WITHOUT Local State and every cookie becomes
    unreadable — the copy "succeeds" but you are still logged out.

    Chrome must be fully closed while copying: the cookie DB is SQLite and a
    live Chrome holds locks, so a copy made while it runs can be corrupt.

.PARAMETER ProfileDir
    Destination profile directory. Default: "%LOCALAPPDATA%\Google\Chrome\User Data DSH".

.PARAMETER SourceUserData
    Your real Chrome "User Data" directory to copy from.
    Default: "%LOCALAPPDATA%\Google\Chrome\User Data".

.PARAMETER Port
    Debug port to use. Default 9222.

.PARAMETER Launch
    After preparing the profile, start Chrome with that profile + debug port.

.PARAMETER Force
    Proceed even if Chrome appears to be running (you accept the risk of a
    corrupt cookie copy). Without it the script refuses and tells you to close
    Chrome first.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File setup-debug-profile.ps1

.EXAMPLE
    # prepare + launch in one go
    powershell -ExecutionPolicy Bypass -File setup-debug-profile.ps1 -Launch

.EXAMPLE
    # custom locations
    powershell -ExecutionPolicy Bypass -File setup-debug-profile.ps1 `
        -ProfileDir "D:\chrome-debug" -Port 9333 -Launch
#>
[CmdletBinding()]
param(
    [string]$ProfileDir = (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data DSH'),
    [string]$SourceUserData = (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'),
    [int]$Port = 9222,
    [switch]$Launch,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    OK  $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "    !!  $msg" -ForegroundColor Yellow }
function Write-Err2($msg) { Write-Host "    XX  $msg" -ForegroundColor Red }

function Find-Chrome {
    $candidates = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
    )
    if ($env:DSH_BROWSER_PATH) { $candidates = @($env:DSH_BROWSER_PATH) + $candidates }
    if ($env:CHROME_PATH)      { $candidates = @($env:CHROME_PATH) + $candidates }
    foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
    return $null
}

function Test-ChromeRunning {
    $p = Get-Process -Name chrome, msedge -ErrorAction SilentlyContinue
    return ($null -ne $p -and @($p).Count -gt 0)
}

function Test-DebugPort([int]$p) {
    $c = New-Object System.Net.Sockets.TcpClient
    try {
        $ar = $c.BeginConnect('127.0.0.1', $p, $null, $null)
        $ok = $ar.AsyncWaitHandle.WaitOne(800)
        if ($ok) { $c.EndConnect($ar) }
        return $ok
    } catch { return $false } finally { $c.Close() }
}

# ---------------------------------------------------------------------------
Write-Step "Locating Chrome"
$chrome = Find-Chrome
if (-not $chrome) {
    Write-Err2 "No Chrome/Edge found. Set DSH_BROWSER_PATH to the browser binary."
    exit 1
}
$version = (Get-Item $chrome).VersionInfo.ProductVersion
Write-Ok "browser: $chrome"
Write-Ok "version: $version"

$major = 0
if ($version -match '^(\d+)') { $major = [int]$Matches[1] }
if ($major -ge 136) {
    Write-Warn2 "Chrome $major >= 136: the default profile CANNOT open a debug port."
    Write-Warn2 "A separate profile (what this script builds) is mandatory."
}

# ---------------------------------------------------------------------------
Write-Step "Checking whether Chrome is running"
if (Test-ChromeRunning) {
    if (-not $Force) {
        Write-Err2 "Chrome is running. Close ALL Chrome windows, then rerun."
        Write-Err2 "Why: the cookie DB is SQLite; copying it while Chrome runs can"
        Write-Err2 "produce a corrupt file and your cookies would not work."
        Write-Err2 "If you accept the risk: rerun with -Force"
        exit 2
    }
    Write-Warn2 "Chrome is running and -Force was given: copying anyway (may be corrupt)."
} else {
    Write-Ok "Chrome is not running (safe to copy)"
}

# ---------------------------------------------------------------------------
Write-Step "Preparing destination profile"
if (-not (Test-Path $ProfileDir)) {
    New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null
    Write-Ok "created: $ProfileDir"
} else {
    Write-Ok "exists: $ProfileDir"
}
$destDefault = Join-Path $ProfileDir 'Default'
if (-not (Test-Path $destDefault)) { New-Item -ItemType Directory -Path $destDefault -Force | Out-Null }

# ---------------------------------------------------------------------------
Write-Step "Copying login state from your real profile"
$srcDefault = Join-Path $SourceUserData 'Default'
if (-not (Test-Path $srcDefault)) {
    Write-Err2 "source profile not found: $srcDefault"
    exit 3
}

# Files inside Default\ that carry sessions. Missing ones are skipped — a
# fresh Chrome has no Login Data until you first log in somewhere.
$files = @(
    'Network\Cookies',            # session cookies (DPAPI-encrypted)
    'Network\Cookies-journal',
    'Login Data',                 # saved passwords (DPAPI)
    'Login Data For Account',
    'Web Data',                   # autofill / form history
    'Preferences',                # per-profile settings, incl. some session state
    'Secure Preferences',
    'Bookmarks',
    'History',
    'Favicons',
    'Top Sites'
)

$copied = 0; $skipped = @()
foreach ($rel in $files) {
    $src = Join-Path $srcDefault $rel
    $dst = Join-Path $destDefault $rel
    if (-not (Test-Path $src)) { $skipped += $rel; continue }
    $dstParent = Split-Path $dst -Parent
    if (-not (Test-Path $dstParent)) { New-Item -ItemType Directory -Path $dstParent -Force | Out-Null }
    try {
        Copy-Item -LiteralPath $src -Destination $dst -Force
        $size = (Get-Item $dst).Length
        Write-Ok ("{0}  ({1:N0} bytes)" -f $rel, $size)
        $copied++
    } catch {
        Write-Warn2 ("could not copy {0}: {1}" -f $rel, $_.Exception.Message)
        $skipped += $rel
    }
}

# ---------------------------------------------------------------------------
# THE critical file: DPAPI key material for decrypting Network\Cookies.
# Without it the copied cookie DB is unreadable and you stay logged out.
Write-Step "Copying Local State (DPAPI key for cookie decryption)"
$localStateSrc = Join-Path $SourceUserData 'Local State'
$localStateDst = Join-Path $ProfileDir 'Local State'
if (Test-Path $localStateSrc) {
    try {
        Copy-Item -LiteralPath $localStateSrc -Destination $localStateDst -Force
        $sz = (Get-Item $localStateDst).Length
        Write-Ok ("Local State  ({0:N0} bytes)" -f $sz)
        $copied++
    } catch {
        Write-Err2 ("FAILED to copy Local State: {0}" -f $_.Exception.Message)
        Write-Err2 "Without it the copied cookies CANNOT be decrypted -> you will be logged out."
        exit 4
    }
} else {
    Write-Err2 "Local State not found at: $localStateSrc"
    Write-Err2 "Without it the copied cookies CANNOT be decrypted -> you will be logged out."
    exit 4
}

Write-Host ""
Write-Host ("Copied {0} item(s)." -f $copied) -ForegroundColor Green
if ($skipped.Count -gt 0) {
    Write-Warn2 ("Not present in your profile (normal for a fresh install): " + ($skipped -join ', '))
}

# ---------------------------------------------------------------------------
Write-Step "Summary"
Write-Host ("    profile dir : {0}" -f $ProfileDir)
Write-Host ("    debug port  : {0}" -f $Port)
Write-Host ""
Write-Host "    Point the plugin at this profile so auto-launch agrees:" -ForegroundColor Cyan
Write-Host ("      setx DSH_BROWSER_USER_DATA_DIR `"{0}`"" -f $ProfileDir)
Write-Host ""
Write-Host "    Or start Chrome yourself with:" -ForegroundColor Cyan
Write-Host ("      `"{0}`" --remote-debugging-port={1} --remote-debugging-address=127.0.0.1 --user-data-dir=`"{2}`" --no-first-run --no-default-browser-check" -f $chrome, $Port, $ProfileDir)

# ---------------------------------------------------------------------------
if ($Launch) {
    Write-Step "Launching Chrome with the debug profile"
    if (Test-DebugPort $Port) {
        Write-Ok "port $Port is already open — not launching another instance"
    } else {
        Start-Process -FilePath $chrome -ArgumentList @(
            "--remote-debugging-port=$Port",
            '--remote-debugging-address=127.0.0.1',
            "--user-data-dir=$ProfileDir",
            '--no-first-run',
            '--no-default-browser-check'
        ) | Out-Null
        $deadline = (Get-Date).AddSeconds(25)
        $opened = $false
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 500
            if (Test-DebugPort $Port) { $opened = $true; break }
        }
        if ($opened) {
            Write-Ok "port $Port is open"
            try {
                $v = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 4
                Write-Ok ("connected: " + $v.Browser)
            } catch {
                Write-Warn2 "port open but /json/version failed: $($_.Exception.Message)"
            }
        } else {
            Write-Err2 "port $Port did not open within 25s."
            Write-Err2 "Check: is another Chrome using this profile dir? Is another"
            Write-Err2 "process holding the port? Try a different -Port."
            exit 5
        }
    }
    Write-Host ""
    Write-Host "Then verify with the plugin's own five tools (browser_tabs list)." -ForegroundColor Cyan
}

exit 0
