#Requires -Version 5.1
<#
  run-docker-app.ps1  (v9.1)
  ===========================================================
  FIX in v9.1 (over v9):
  - FIX .NET CWD mismatch: dung Read-TextSafe/Write-TextSafe resolve absolute path
  - FIX NativeCommandError do docker stderr voi $ErrorActionPreference=Stop
  - FIX filter chuoi rong khoi danh sach "da sua"
  - FIX HardLock path bug
  - FIX filter warning "version is obsolete" khoi output loi

  NEW in v9:
  - HARD-LOCK: tuyet doi khong pull image tu compose
  - AUTO-RECOVERY: neu compose hien tai fail -> sinh compose toi uu + retry
  - i18n: -Lang auto|en|vi

  Van giu tu v8:
  - Tu phat hien loai app + sinh docker-compose.auto.yml
  - Find-AppRoot thong minh

  Van giu tu v7:
  - Nap app truc tiep tu .zip
  - Auto-fix compose (BOM/CRLF/tab)

  Van giu tu v6:
  - Wait container running, retry do port 10 lan, HTTP probe
  - .env thong minh, menu tuong tac

  Cach dung:
    .\run-docker-app.ps1
    .\run-docker-app.ps1 -ZipFile "app.zip" -Force
    .\run-docker-app.ps1 -Lang en
    .\run-docker-app.ps1 -NoHardLock -NoAutoRecover
    .\run-docker-app.ps1 -Down / -Logs / -NoBrowser / -Force
#>

[CmdletBinding()]
param(
    [switch]$Down,
    [switch]$Logs,
    [switch]$NoBrowser,
    [switch]$Force,
    [int]$HealthTimeoutSec = 90,
    [int]$ReadyTimeoutSec  = 60,
    [string[]]$ComposeFile,
    [string]$ZipFile,
    [string]$ExtractDir,
    [switch]$NoAutoFix,
    [switch]$NoExtract,
    # ---- v9 ----
    [ValidateSet("auto","en","vi")]
    [string]$Lang = "auto",
    [switch]$NoHardLock,
    [switch]$NoAutoRecover
)

$ErrorActionPreference = "Stop"
$script:StartTime = Get-Date
try {
    [System.Threading.Thread]::CurrentThread.CurrentCulture = [System.Globalization.CultureInfo]::InvariantCulture
} catch {}

Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.IO.Compression -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue

# =========================================================
#  i18n LAYER (v9)
# =========================================================
function Get-CurrentLang {
    param([string]$Req)
    if ($Req -and $Req -ne "auto") { return $Req }
    try {
        $two = [System.Globalization.CultureInfo]::CurrentUICulture.TwoLetterISOLanguageName
        if ($two -eq "vi") { return "vi" }
    } catch {}
    return "en"
}

$script:Lang = Get-CurrentLang -Req $Lang

$script:Msg = @{
    en = @{
        LangDetected           = "Language: {0} (override with -Lang en|vi)"
        HardLockTitle          = "HARD-LOCK: Prevent pulling images from remote"
        HardLockApplied        = "Applied 'pull_policy: never' to {0} service(s)."
        HardLockBuildAdded     = "Added 'build: .' to service '{0}' (was image-only)."
        HardLockInfraSkipped   = "Service '{0}' uses infra image '{1}' -> kept, may need pre-pull."
        HardLockBackup         = "Backup saved: {0}"
        HardLockSkippedFlag    = "Hard-lock disabled by -NoHardLock."
        HardLockNoChange       = "No service needed hard-lock changes."
        HardLockSkippedAuto    = "Skip hard-lock for auto-generated compose."
        RecoveryTitle          = "AUTO-RECOVERY: Previous compose failed"
        RecoveryReason         = "Reason: {0}"
        RecoveryBackup         = "Backup original: {0}"
        RecoveryComposeCreated = "New compose created: {0}"
        RecoveryRetry          = "Retrying with new compose..."
        RecoverySuccess        = "Recovery successful!"
        RecoveryFailed         = "Recovery FAILED. See logs above."
        RecoveryDisabled       = "Auto-recovery disabled by -NoAutoRecover."
        RecoveryLogsTitle      = "Last 60 log lines from failed attempt:"
        RecoveryComposeHeader  = "--- New compose content ---"
        UpFailed               = "docker compose up failed (exit {0})."
        UpSuccess              = "Containers started."
    }
    vi = @{
        LangDetected           = "Ngon ngu: {0} (ghi de bang -Lang en|vi)"
        HardLockTitle          = "HARD-LOCK: Chan tai image tu remote"
        HardLockApplied        = "Da ap dung 'pull_policy: never' cho {0} service."
        HardLockBuildAdded     = "Da them 'build: .' cho service '{0}' (truoc chi co image)."
        HardLockInfraSkipped   = "Service '{0}' dung image ha tang '{1}' -> giu nguyen, co the can pull truoc."
        HardLockBackup         = "Da luu backup: {0}"
        HardLockSkippedFlag    = "Hard-lock bi tat boi -NoHardLock."
        HardLockNoChange       = "Khong co service nao can hard-lock."
        HardLockSkippedAuto    = "Bo qua hard-lock voi compose tu sinh."
        RecoveryTitle          = "AUTO-RECOVERY: Compose truoc do that bai"
        RecoveryReason         = "Ly do: {0}"
        RecoveryBackup         = "Backup ban goc: {0}"
        RecoveryComposeCreated = "Da tao compose moi: {0}"
        RecoveryRetry          = "Dang thu lai voi compose moi..."
        RecoverySuccess        = "Phuc hoi thanh cong!"
        RecoveryFailed         = "Phuc hoi THAT BAI. Xem log phia tren."
        RecoveryDisabled       = "Auto-recovery bi tat boi -NoAutoRecover."
        RecoveryLogsTitle      = "60 dong log cuoi cua lan chay that bai:"
        RecoveryComposeHeader  = "--- Noi dung compose moi ---"
        UpFailed               = "docker compose up that bai (exit {0})."
        UpSuccess              = "Da khoi dong container."
    }
}

function T {
    param([string]$Key, [object[]]$Value)
    $dict = $script:Msg[$script:Lang]
    if (-not $dict) { $dict = $script:Msg["en"] }
    $tpl = $dict[$Key]
    if (-not $tpl) { $tpl = $script:Msg["en"][$Key] }
    if (-not $tpl) { return "[$Key]" }
    if ($PSBoundParameters.ContainsKey('Value') -and $null -ne $Value) {
        try { return ($tpl -f $Value) } catch { return $tpl }
    }
    return $tpl
}

# =========================================================
#  HELPERS
# =========================================================
function Write-Step($m){ Write-Host ""; Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok  ($m){ Write-Host "[OK] $m" -ForegroundColor Green }
function Write-Warn($m){ Write-Host "[!]  $m" -ForegroundColor Yellow }
function Write-Err ($m){ Write-Host "[X]  $m" -ForegroundColor Red }
function Write-Dim ($m){ Write-Host $m -ForegroundColor DarkGray }

function Fail($msg, [int]$code=1){
    Write-Err $msg
    Write-Host ""
    Write-Host "Nhan Enter de dong..." -ForegroundColor DarkGray
    [void](Read-Host)
    exit $code
}

function Write-LogLine {
    param([object]$line)
    if ($null -eq $line) { return }
    $s = [string]$line
    if ([string]::IsNullOrWhiteSpace($s)) { Write-Host ""; return }
    if ($s -match '(?i)\b(error|exception|fatal|traceback|panic|failed|failure|critical)\b') {
        Write-Host $s -ForegroundColor Red
    } elseif ($s -match '(?i)\bwarn(ing)?\b') {
        Write-Host $s -ForegroundColor Yellow
    } else {
        Write-Host $s
    }
}

# --- v9.1: Safe file IO (resolve absolute path de tranh .NET CWD mismatch) ---
function Resolve-AbsPath {
    param([string]$Path, [string]$BaseDir)
    if (-not $BaseDir) { $BaseDir = (Get-Location).Path }
    try {
        if ([System.IO.Path]::IsPathRooted($Path)) { return $Path }
        return [System.IO.Path]::GetFullPath((Join-Path $BaseDir $Path))
    } catch { return $Path }
}

function Read-TextSafe {
    param([string]$Path)
    $abs = Resolve-AbsPath -Path $Path
    if (-not (Test-Path -LiteralPath $abs -PathType Leaf)) {
        return [pscustomobject]@{ Ok=$false; Path=$abs; Text=$null; Error="File not found" }
    }
    try {
        $t = [System.IO.File]::ReadAllText($abs)
        return [pscustomobject]@{ Ok=$true; Path=$abs; Text=$t; Error=$null }
    } catch {
        return [pscustomobject]@{ Ok=$false; Path=$abs; Text=$null; Error=$_.Exception.Message }
    }
}

function Write-TextSafe {
    param([string]$Path, [string]$Text)
    $abs = Resolve-AbsPath -Path $Path
    try {
        $enc = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($abs, $Text, $enc)
        return $true
    } catch {
        Write-Warn "Khong ghi duoc $abs : $($_.Exception.Message)"
        return $false
    }
}

# --- v9.1: Goi native an toan (khong bi NativeCommandError khi stderr co warning) ---
function Invoke-Compose {
    param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Args)
    $saved = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & docker compose @script:composeArgs @Args
    } finally {
        $ErrorActionPreference = $saved
    }
}

# --- v9.1: Goi native command bat ky voi EAP Continue ---
function Invoke-Native {
    param(
        [string]$Cmd,
        [string[]]$CmdArgs = @(),
        [switch]$Capture
    )
    $saved = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        if ($Capture) {
            $out = & $Cmd @CmdArgs 2>&1 | Out-String
            return [pscustomobject]@{ Output=$out; Code=$LASTEXITCODE }
        } else {
            & $Cmd @CmdArgs 2>&1 | ForEach-Object { Write-LogLine $_ }
            return [pscustomobject]@{ Output=""; Code=$LASTEXITCODE }
        }
    } finally {
        $ErrorActionPreference = $saved
    }
}

# =========================================================
#  0. CD
# =========================================================
if ($PSScriptRoot) { Set-Location -LiteralPath $PSScriptRoot }
Write-Dim "Thu muc lam viec: $PWD"
Write-Dim ((T "LangDetected") -f $script:Lang)

# =========================================================
#  1. DOCKER
# =========================================================
Write-Step "Kiem tra Docker..."
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Fail "Khong tim thay lenh 'docker'. Cai Docker Desktop va them vao PATH."
}
$chk = Invoke-Native -Cmd "docker" -CmdArgs @("version","--format","{{.Server.Version}}") -Capture
if ($chk.Code -ne 0) {
    Fail "Docker daemon khong phan hoi. Mo Docker Desktop va doi khoi dong xong."
}
Write-Ok "Docker san sang."

# =========================================================
#  1.5 ZIP APP LOADER
# =========================================================
function Expand-AppZip {
    param(
        [string]$ZipPath,
        [string]$DestDir,
        [switch]$Force
    )
    if (Test-Path -LiteralPath $DestDir) {
        if ($Force) {
            Remove-Item -LiteralPath $DestDir -Recurse -Force -ErrorAction SilentlyContinue
        } else {
            $items = @(Get-ChildItem -LiteralPath $DestDir -Force -ErrorAction SilentlyContinue)
            if ($items.Count -gt 0) {
                Write-Warn "Thu muc '$DestDir' da co du lieu. Bo qua giai nen (dung -Force de ghi de)."
                return $true
            }
        }
    }
    New-Item -ItemType Directory -Path $DestDir -Force | Out-Null

    $zip = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        $fullDest = [System.IO.Path]::GetFullPath($DestDir).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
        $count = 0
        $skipped = 0
        foreach ($entry in $zip.Entries) {
            $rel = $entry.FullName -replace '\\','/'
            if ($rel -match '(^|/)\.\.(/|$)' -or $rel -match '^/' -or $rel -match '^[A-Za-z]:') {
                Write-Warn "  Bo qua entry khong an toan: $rel"
                $skipped++
                continue
            }
            $targetPath = [System.IO.Path]::GetFullPath((Join-Path $fullDest $rel))
            if (-not $targetPath.StartsWith($fullDest, [System.StringComparison]::OrdinalIgnoreCase)) {
                Write-Warn "  Bo qua entry ngoai dest: $rel"
                $skipped++
                continue
            }
            if ($entry.Name -eq "") {
                New-Item -ItemType Directory -Path $targetPath -Force | Out-Null
                continue
            }
            $parent = [System.IO.Path]::GetDirectoryName($targetPath)
            if (-not (Test-Path -LiteralPath $parent)) {
                New-Item -ItemType Directory -Path $parent -Force | Out-Null
            }
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $targetPath, $true)
            $count++
        }
        Write-Ok "Giai nen $count file$(if($skipped -gt 0){" (bo qua $skipped entry)"})."
    } finally {
        $zip.Dispose()
    }
    return $true
}

function Find-ComposeInDir {
    param([string]$Root)
    foreach ($c in @("docker-compose.yml","docker-compose.yaml","compose.yml","compose.yaml")) {
        $p = Join-Path $Root $c
        if (Test-Path -LiteralPath $p -PathType Leaf) { return $p }
    }
    return $null
}

function Find-AppRoot {
    param([string]$Root)
    if (Find-ComposeInDir -Root $Root) { return $Root }
    $subdirs = @(Get-ChildItem -LiteralPath $Root -Directory -Force -ErrorAction SilentlyContinue)
    foreach ($d in $subdirs) {
        if (Find-ComposeInDir -Root $d.FullName) { return $d.FullName }
    }
    foreach ($d in $subdirs) {
        $sub2 = @(Get-ChildItem -LiteralPath $d.FullName -Directory -Force -ErrorAction SilentlyContinue)
        foreach ($dd in $sub2) {
            if (Find-ComposeInDir -Root $dd.FullName) { return $dd.FullName }
        }
    }
    $files = @(Get-ChildItem -LiteralPath $Root -File -Force -ErrorAction SilentlyContinue |
               Where-Object { $_.Name -notmatch '^\._' })
    if ($subdirs.Count -eq 1 -and $files.Count -le 1) {
        return $subdirs[0].FullName
    }
    return $Root
}

if (-not $Down -and -not $Logs -and -not $NoExtract) {
    $zipToLoad = $null

    if ($ZipFile) {
        if (-not (Test-Path -LiteralPath $ZipFile -PathType Leaf)) {
            Fail "Khong tim thay file zip: $ZipFile"
        }
        $zipToLoad = (Resolve-Path -LiteralPath $ZipFile).Path
    } else {
        $hasComposeHere = @(@("docker-compose.yml","docker-compose.yaml","compose.yml","compose.yaml") |
                            Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
        if ($hasComposeHere.Count -eq 0) {
            $foundZips = @(Get-ChildItem -Path "." -Filter "*.zip" -File -ErrorAction SilentlyContinue)
            if ($foundZips.Count -eq 1) {
                $zipToLoad = $foundZips[0].FullName
                Write-Dim "Phat hien zip: $($foundZips[0].Name)"
            } elseif ($foundZips.Count -gt 1) {
                Write-Step "Co $($foundZips.Count) file zip. Chon 1 de nap:"
                for ($i=0; $i -lt $foundZips.Count; $i++) {
                    Write-Host ("   [{0}] {1}" -f ($i+1), $foundZips[$i].Name) -ForegroundColor White
                }
                Write-Host "   [0] Bo qua (khong giai nen)" -ForegroundColor DarkGray
                $sel = Read-Host "  Chon"
                $idx = 0
                if ([int]::TryParse($sel, [ref]$idx) -and $idx -ge 1 -and $idx -le $foundZips.Count) {
                    $zipToLoad = $foundZips[$idx-1].FullName
                }
            }
        }
    }

    if ($zipToLoad) {
        Write-Step "Giai nen app tu: $(Split-Path -Leaf $zipToLoad)"
        $appName = [System.IO.Path]::GetFileNameWithoutExtension($zipToLoad)
        if (-not $ExtractDir) {
            $ExtractDir = Join-Path $PWD.Path $appName
        }
        [void](Expand-AppZip -ZipPath $zipToLoad -DestDir $ExtractDir -Force:$Force)

        if (Test-Path -LiteralPath $ExtractDir) {
            $resolvedExtract = (Resolve-Path -LiteralPath $ExtractDir).Path
            $appRoot = Find-AppRoot -Root $resolvedExtract
            if ($appRoot) {
                Set-Location -LiteralPath $appRoot
                $script:AppRoot = $appRoot
                Write-Ok "App root: $appRoot"
            } else {
                Set-Location -LiteralPath $resolvedExtract
            }
        }
    }
}

# =========================================================
#  1.6 APP TYPE DETECTION + AUTO-COMPOSE GENERATOR
# =========================================================
function Get-AppProfile {
    param([string]$Root)

    $profile = [pscustomobject]@{
        Type          = "unknown"
        Port          = 80
        Image         = "nginx:alpine"
        Build         = $false
        Dockerfile    = $null
        Command       = $null
        MountTarget   = "/usr/share/nginx/html"
        MountReadOnly = $true
    }

    $df = $null
    foreach ($name in @("Dockerfile","dockerfile","Dockerfile.dev","Dockerfile.prod","Dockerfile.local")) {
        $p = Join-Path $Root $name
        if (Test-Path -LiteralPath $p -PathType Leaf) { $df = $name; break }
    }

    $hasNode   = Test-Path -LiteralPath (Join-Path $Root "package.json") -PathType Leaf
    $hasPython = (Test-Path -LiteralPath (Join-Path $Root "requirements.txt") -PathType Leaf) -or
                 (Test-Path -LiteralPath (Join-Path $Root "pyproject.toml") -PathType Leaf) -or
                 (Test-Path -LiteralPath (Join-Path $Root "Pipfile") -PathType Leaf)
    $hasGo     = Test-Path -LiteralPath (Join-Path $Root "go.mod") -PathType Leaf
    $hasDotnet = @(Get-ChildItem -LiteralPath $Root -Filter "*.csproj" -File -ErrorAction SilentlyContinue).Count -gt 0
    $hasPhp    = Test-Path -LiteralPath (Join-Path $Root "composer.json") -PathType Leaf
    $hasHtml   = Test-Path -LiteralPath (Join-Path $Root "index.html") -PathType Leaf

    if ($hasNode) {
        $profile.Type = "node"; $profile.Port = 3000
        $profile.Image = "node:20-alpine"
        $profile.MountTarget = "/app"; $profile.MountReadOnly = $false
        $scriptName = "start"
        try {
            $pkg = Get-Content -LiteralPath (Join-Path $Root "package.json") -Raw | ConvertFrom-Json
            if (-not $pkg.scripts.start -and $pkg.scripts.dev) { $scriptName = "dev" }
            $startCmd = [string]$pkg.scripts.start
            if ($startCmd -and $startCmd -match '(-p|--port)[= ]+(\d{2,5})') {
                $profile.Port = [int]$Matches[2]
            }
        } catch {}
        $profile.Command = @("sh","-c","npm install --no-audit --no-fund && npm run $scriptName")
    } elseif ($hasPython) {
        $profile.Type = "python"; $profile.Port = 8000
        $profile.Image = "python:3.11-slim"
        $profile.MountTarget = "/app"; $profile.MountReadOnly = $false
        $entry = "app.py"
        foreach ($cand in @("app.py","main.py","server.py","run.py","manage.py")) {
            if (Test-Path -LiteralPath (Join-Path $Root $cand)) { $entry = $cand; break }
        }
        $profile.Command = @("sh","-c","pip install --no-cache-dir -r requirements.txt 2>/dev/null || pip install --no-cache-dir . ; python $entry")
    } elseif ($hasGo) {
        $profile.Type = "go"; $profile.Port = 8080
        $profile.Image = "golang:1.22-alpine"
        $profile.MountTarget = "/app"; $profile.MountReadOnly = $false
        $profile.Command = @("sh","-c","go build -o /tmp/app . && /tmp/app")
    } elseif ($hasDotnet) {
        $profile.Type = "dotnet"; $profile.Port = 8080
        $profile.Image = "mcr.microsoft.com/dotnet/sdk:8.0"
        $profile.MountTarget = "/app"; $profile.MountReadOnly = $false
        $profile.Command = @("sh","-c","dotnet restore && dotnet run --urls http://0.0.0.0:8080")
    } elseif ($hasPhp) {
        $profile.Type = "php"; $profile.Port = 80
        $profile.Image = "php:8.2-apache"
        $profile.MountTarget = "/var/www/html"; $profile.MountReadOnly = $false
        $profile.Command = $null
    } elseif ($hasHtml) {
        $profile.Type = "static"; $profile.Port = 80
        $profile.Image = "nginx:alpine"
        $profile.MountTarget = "/usr/share/nginx/html"; $profile.MountReadOnly = $true
        $profile.Command = $null
    } else {
        $profile.Type = "static-fallback"; $profile.Port = 80
        $profile.Image = "nginx:alpine"
        $profile.MountTarget = "/usr/share/nginx/html"; $profile.MountReadOnly = $true
        $profile.Command = $null
    }

    if ($df) {
        $profile.Dockerfile = $df
        $profile.Build = $true
        try {
            $content = Get-Content -LiteralPath (Join-Path $Root $df) -Raw
            if ($content -match '(?im)^\s*EXPOSE\s+(\d{1,5})') {
                $profile.Port = [int]$Matches[1]
            }
        } catch {}
    }

    return $profile
}

function New-AutoComposeFile {
    param([string]$Root, [string]$Name = "docker-compose.auto.yml")

    $profile = Get-AppProfile -Root $Root
    $outPath = Join-Path $Root $Name
    $svcName = if ($profile.Type -eq "unknown") { "app" } else { "$($profile.Type)-app" }

    $L = New-Object System.Collections.Generic.List[string]
    $L.Add("# Auto-generated by run-docker-app.ps1 (v9.1)")
    $L.Add("# Detected app type : $($profile.Type)")
    $L.Add("# Generated at      : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
    $L.Add("# Ban co the chinh sua file nay. Script se khong ghi de.")
    $L.Add("services:")
    $L.Add("  ${svcName}:")

    if ($profile.Build -and $profile.Dockerfile) {
        $L.Add("    build:")
        $L.Add("      context: .")
        $L.Add("      dockerfile: $($profile.Dockerfile)")
        $L.Add("    ports:")
        $L.Add("      - `"$($profile.Port):$($profile.Port)`"")
    } else {
        $L.Add("    image: $($profile.Image)")
        if ($profile.Command) {
            $cmdParts = @()
            foreach ($arg in $profile.Command) {
                $escaped = $arg -replace '\\','\\' -replace '"','\"'
                $cmdParts += '"' + $escaped + '"'
            }
            $L.Add("    command: [" + ($cmdParts -join ", ") + "]")
        }
        $ro = if ($profile.MountReadOnly) { ":ro" } else { "" }
        $L.Add("    volumes:")
        $L.Add("      - ./:$($profile.MountTarget)$ro")
        $L.Add("    ports:")
        $L.Add("      - `"$($profile.Port):$($profile.Port)`"")
        if ($profile.Type -in @("node","python","go","dotnet")) {
            $L.Add("    environment:")
            $L.Add("      PORT: `"$($profile.Port)`"")
        }
    }
    $L.Add("    restart: unless-stopped")

    $content = ($L -join "`n") + "`n"
    [void](Write-TextSafe -Path $outPath -Text $content)

    return [pscustomobject]@{ Path = $outPath; Profile = $profile }
}

# =========================================================
#  2. COMPOSE FILE
# =========================================================
$script:AutoCompose = $false
$script:AppProfile  = $null

if (-not $ComposeFile -or $ComposeFile.Count -eq 0) {
    $candidates = @("docker-compose.yml","docker-compose.yaml","compose.yml","compose.yaml","docker-compose.auto.yml")
    $found = @($candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })

    if ($found.Count -eq 0) {
        Write-Warn "Khong tim thay docker-compose nao."
        Write-Step "Tu dong phan tich app va sinh compose..."

        $prof = Get-AppProfile -Root $PWD.Path
        Write-Host "  Loai app phat hien : $($prof.Type)" -ForegroundColor White
        Write-Host "  Port du kien       : $($prof.Port)" -ForegroundColor White
        if ($prof.Dockerfile) {
            Write-Host "  Dockerfile         : $($prof.Dockerfile)" -ForegroundColor White
        } else {
            Write-Host "  Image su dung      : $($prof.Image)" -ForegroundColor White
        }

        $gen = New-AutoComposeFile -Root $PWD.Path
        $script:AutoCompose = $true
        $script:AppProfile  = $gen.Profile
        $ComposeFile = @($gen.Path)

        Write-Ok "Da sinh: $($gen.Path)"
        Write-Host ""
        Write-Host "  --- Noi dung ---" -ForegroundColor Cyan
        Get-Content -LiteralPath $gen.Path | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
        Write-Host "  ---------------" -ForegroundColor Cyan
        Write-Host ""
        Write-Warn "Neu app cua ban can cau hinh khac, sua file '$($gen.Path)' truoc khi tiep tuc."
        if (-not $Force) {
            $ans = Read-Host "  Tiep tuc chay? (Y/n)"
            if ($ans -match '^(n|no)$') { Fail "Da huy boi nguoi dung." }
        }
    } else {
        $ComposeFile = @($found[0])
    }
}

foreach ($f in $ComposeFile) {
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) {
        Fail "Khong tim thay file compose: $f"
    }
}
Write-Ok "Compose: $($ComposeFile -join ', ')$(if($script:AutoCompose){'  (auto-generated)'})"

$script:composeArgs = @()
foreach ($f in $ComposeFile) { $script:composeArgs += @("-f", $f) }

# =========================================================
#  2.5 AUTO-FIX COMPOSE
# =========================================================
function Repair-ComposeFile {
    param([string]$Path)
    $changed = @()
    $read = Read-TextSafe -Path $Path
    if (-not $read.Ok) {
        Write-Warn "Khong doc duoc $Path : $($read.Error)"
        return ,([string[]]@())
    }
    $raw = $read.Text
    $absPath = $read.Path
    $original = $raw

    if ($raw.Length -gt 0 -and [int][char]$raw[0] -eq 0xFEFF) {
        $raw = $raw.Substring(1)
        $changed += "Loai bo BOM UTF-8"
    }

    $lf = $raw -replace "`r`n", "`n" -replace "`r", "`n"
    if ($lf -ne $raw) { $changed += "Chuan hoa CRLF -> LF"; $raw = $lf }

    $noTab = [regex]::Replace($raw, '(?m)^(\t+)', {
        param($m)
        '  ' * $m.Groups[1].Value.Length
    })
    if ($noTab -ne $raw) { $changed += "Doi tab indent -> 2 spaces"; $raw = $noTab }

    if ($raw -notmatch '(?m)^services\s*:') {
        $changed += "Them 'services:' (thieu o top-level)"
        $raw = "services:`n" + $raw
    }

    $quoted = [regex]::Replace($raw, '(?m)^(\s*-\s*)(\d{1,5}:\d{1,5})(\s*)$', '$1"$2"$3')
    if ($quoted -ne $raw) { $changed += "Quote port 'xxxx:yyyy'"; $raw = $quoted }

    if ($raw.Length -gt 0 -and -not $raw.EndsWith("`n")) {
        $raw += "`n"
        $changed += "Them newline cuoi file"
    }

    if ($raw -ne $original) {
        [void](Write-TextSafe -Path "$absPath.bak" -Text $original)
        [void](Write-TextSafe -Path $absPath -Text $raw)
    }
    return ,([string[]]$changed)
}

function Test-ComposeValid {
    param([string[]]$Files)
    $cargs = @()
    foreach ($f in $Files) { $cargs += @("-f", $f) }

    $saved = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $out = ""
    $code = 0
    try {
        $out = & docker compose @cargs config 2>&1 | Out-String
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $saved
    }

    $clean = ($out -split "`r?`n" | Where-Object {
        $_ -notmatch 'the attribute `?version`? is obsolete'
    }) -join "`n"

    if ($code -eq 0) {
        return [pscustomobject]@{ Ok=$true; Output="" }
    }
    return [pscustomobject]@{ Ok=$false; Output=$clean }
}

function Invoke-AutoFixCompose {
    param([string[]]$Files)
    Write-Step "Kiem tra va tu sua docker-compose..."
    $anyChange = $false
    foreach ($f in $Files) {
        $ch = @(Repair-ComposeFile -Path $f | Where-Object { $_ -and ("$_").Trim() -ne "" })
        if ($ch.Count -gt 0) {
            $anyChange = $true
            Write-Warn "Da sua '$f':"
            foreach ($c in $ch) { Write-Dim "     - $c" }
        } else {
            Write-Dim "   [$f] khong co loi pho bien."
        }
    }
    if ($anyChange) {
        Write-Dim "   (File goc da duoc backup thanh *.bak)"
    }

    $v = Test-ComposeValid -Files $Files
    if ($v.Ok) {
        Write-Ok "docker-compose hop le."
        return $true
    }
    Write-Warn "docker compose config van bao loi (van tiep tuc chay):"
    if ($v.Output) {
        foreach ($line in ($v.Output -split "`n")) { Write-LogLine $line }
    }
    return $false
}

if (-not $NoAutoFix -and -not $Down -and -not $Logs) {
    [void](Invoke-AutoFixCompose -Files $ComposeFile)
}

# =========================================================
#  2.6 HARD-LOCK (v9): chan pull image tu remote
# =========================================================
$script:KnownInfraPatterns = @(
    '^postgres', '^mysql', '^mariadb', '^mongo', '^redis', '^memcached',
    '^rabbitmq', '^kafka', '^zookeeper', '^elasticsearch', '^opensearch',
    '^nginx$', '^httpd', '^caddy', '^traefik', '^haproxy', '^envoy',
    '^minio', '^cassandra', '^couchdb', '^neo4j', '^influxdb',
    '^grafana', '^prometheus', '^jaeger', '^zipkin',
    '^mailhog', '^mailcatcher', '^adminer', '^phpmyadmin'
)

function Test-KnownInfraImage {
    param([string]$Image)
    if (-not $Image) { return $false }
    $name = $Image.Trim('"',"'")
    $name = $name -replace ':.*$', ''
    if ($name -match '^[^/]+/(.+)$') { $name = $Matches[1] }
    if ($name -match '^[^/]+/(.+)$') { $name = $Matches[1] }
    $name = $name.ToLower()
    foreach ($pat in $script:KnownInfraPatterns) {
        if ($name -match $pat) { return $true }
    }
    return $false
}

function Repair-ComposeHardLock {
    param(
        [string]$Path,
        [string]$DefaultDockerfile = $null
    )
    $changed = @()
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return ,([string[]]@()) }
    $read = Read-TextSafe -Path $Path
    if (-not $read.Ok) { return ,([string[]]@()) }
    $raw = $read.Text
    $absPath = $read.Path
    $raw = $raw -replace "`r`n", "`n" -replace "`r", "`n"
    $lines = @($raw -split "`n")

    $services = @()
    $inServices = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        if ($line -match '^services\s*:\s*$') { $inServices = $true; continue }
        if (-not $inServices) { continue }
        if ($line -match '^[A-Za-z_][A-Za-z0-9_\-]*\s*:') {
            $inServices = $false
            continue
        }
        if ($line -match '^  ([A-Za-z_][A-Za-z0-9_\-]*)\s*:\s*$') {
            $services += [pscustomobject]@{
                Name = $Matches[1]
                Line = $i
            }
        }
    }

    if ($services.Count -eq 0) { return ,([string[]]@()) }

    $ranges = @()
    for ($k = 0; $k -lt $services.Count; $k++) {
        $start = $services[$k].Line
        $end = if ($k+1 -lt $services.Count) { $services[$k+1].Line - 1 } else { $lines.Count - 1 }
        $hasBuild = $false
        $hasPullPolicy = $false
        $imageVal = $null
        for ($j = $start; $j -le $end; $j++) {
            if ($lines[$j] -match '^\s{4}build\s*:') { $hasBuild = $true }
            if ($lines[$j] -match '^\s{4}pull_policy\s*:') { $hasPullPolicy = $true }
            if ($lines[$j] -match '^\s{4}image\s*:\s*(.+?)\s*$') {
                if (-not $imageVal) { $imageVal = $Matches[1].Trim('"',"'") }
            }
        }
        $ranges += [pscustomobject]@{
            Name = $services[$k].Name
            Start = $start
            End = $end
            HasBuild = $hasBuild
            HasPullPolicy = $hasPullPolicy
            Image = $imageVal
        }
    }

    $injections = @{}
    foreach ($r in $ranges) {
        $inj = @()
        if ($r.Image) {
            $isInfra = Test-KnownInfraImage -Image $r.Image
            if ($r.HasBuild) {
                if (-not $r.HasPullPolicy) {
                    $inj += "    pull_policy: never"
                    $changed += "pull_policy: never -> $($r.Name)"
                }
            } elseif ($isInfra) {
                Write-Warn ((T "HardLockInfraSkipped") -f $r.Name, $r.Image)
            } else {
                if ($DefaultDockerfile) {
                    $inj += "    build:"
                    $inj += "      context: ."
                    if ($DefaultDockerfile -ne "Dockerfile") {
                        $inj += "      dockerfile: $DefaultDockerfile"
                    }
                    $changed += ((T "HardLockBuildAdded") -f $r.Name)
                }
                if (-not $r.HasPullPolicy) {
                    $inj += "    pull_policy: never"
                    $changed += "pull_policy: never -> $($r.Name)"
                }
            }
        } elseif ($r.HasBuild) {
            if (-not $r.HasPullPolicy) {
                $inj += "    pull_policy: never"
                $changed += "pull_policy: never -> $($r.Name)"
            }
        }
        if ($inj.Count -gt 0) {
            $injections[$r.Start] = $inj
        }
    }

    if ($changed.Count -eq 0) { return ,([string[]]@()) }

    $out = New-Object System.Collections.Generic.List[string]
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $out.Add($lines[$i])
        if ($injections.ContainsKey($i)) {
            foreach ($injLine in $injections[$i]) {
                $out.Add($injLine)
            }
        }
    }

    try {
        [void](Write-TextSafe -Path "$absPath.pre-lock.bak" -Text $raw)
        [void](Write-TextSafe -Path $absPath -Text ($out -join "`n"))
    } catch {
        Write-Warn "Khong ghi duoc file hard-lock: $($_.Exception.Message)"
    }

    return ,([string[]]$changed)
}

if (-not $NoHardLock -and -not $Down -and -not $Logs) {
    Write-Step (T "HardLockTitle")

    $skipHardLock = $false
    foreach ($f in $ComposeFile) {
        if ($f -match 'docker-compose\.(auto|recovered)\.yml$') {
            $skipHardLock = $true
            break
        }
    }

    if ($skipHardLock) {
        Write-Dim "  " + (T "HardLockSkippedAuto")
    } else {
        $df = $null
        foreach ($name in @("Dockerfile","dockerfile","Dockerfile.dev","Dockerfile.prod")) {
            if (Test-Path -LiteralPath $name -PathType Leaf) { $df = $name; break }
        }
        $totalChanges = 0
        foreach ($f in $ComposeFile) {
            $ch = @(Repair-ComposeHardLock -Path $f -DefaultDockerfile $df | Where-Object { $_ -and ("$_").Trim() -ne "" })
            if ($ch.Count -gt 0) {
                $totalChanges += $ch.Count
                Write-Dim "  [$f]"
                foreach ($c in $ch) { Write-Dim "     - $c" }
                $bak = "$f.pre-lock.bak"
                if (Test-Path -LiteralPath $bak) {
                    Write-Dim ("     " + ((T "HardLockBackup") -f $bak))
                }
            }
        }
        if ($totalChanges -gt 0) {
            Write-Ok ((T "HardLockApplied") -f $totalChanges)
        } else {
            Write-Dim "  " + (T "HardLockNoChange")
        }
    }
} elseif ($NoHardLock) {
    Write-Warn (T "HardLockSkippedFlag")
}

# =========================================================
#  3. -Down
# =========================================================
if ($Down) {
    Write-Step "Dung va go container..."
    Invoke-Compose down
    if ($LASTEXITCODE -ne 0) { Fail "docker compose down that bai." }
    Write-Ok "Da dung."
    Read-Host "Nhan Enter de dong"
    exit 0
}

# =========================================================
#  4. -Logs
# =========================================================
if ($Logs) {
    Write-Step "Tail log (Ctrl+C de thoat)..."
    $saved = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & docker compose @script:composeArgs logs -f --tail=200 2>&1 |
            ForEach-Object { Write-LogLine $_ }
    } finally {
        $ErrorActionPreference = $saved
    }
    exit $LASTEXITCODE
}

# =========================================================
#  5. .ENV THONG MINH
# =========================================================
function Get-ComposeEnvVars {
    $set = New-Object System.Collections.Generic.HashSet[string]
    foreach ($f in $ComposeFile) {
        $read = Read-TextSafe -Path $f
        if (-not $read.Ok) { continue }
        $raw = $read.Text
        foreach ($m in [regex]::Matches($raw, '\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}')) {
            [void]$set.Add($m.Groups[1].Value)
        }
        foreach ($m in [regex]::Matches($raw, '(?<![A-Za-z0-9_])\$([A-Za-z_][A-Za-z0-9_]*)\b')) {
            [void]$set.Add($m.Groups[1].Value)
        }
        $inEnv = $false
        foreach ($line in ($raw -split "`r?`n")) {
            if ($line -match '^\s*environment\s*:\s*$') { $inEnv = $true; continue }
            if ($inEnv -and $line -match '^\s{0,2}\S' -and $line -notmatch '^\s*environment') { $inEnv = $false }
            if ($inEnv -and $line -match '^\s*-\s*([A-Za-z_][A-Za-z0-9_]*)\s*=') { [void]$set.Add($Matches[1]) }
            if ($inEnv -and $line -match '^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\S') { [void]$set.Add($Matches[1]) }
        }
    }
    return @($set) | Sort-Object
}

function Invoke-EnvConfig {
    Write-Step "Cau hinh moi truong (.env)"
    $detected = @(Get-ComposeEnvVars)
    $hasEnv   = Test-Path -LiteralPath ".env" -PathType Leaf
    $example  = @(".env.example",".env.sample","env.example") |
                Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1

    if ($detected.Count -gt 0) {
        Write-Dim "  Compose tham chieu $($detected.Count) bien: $($detected -join ', ')"
    } else {
        Write-Dim "  Khong phat hien bien moi truong nao trong compose."
    }

    if ($hasEnv) {
        Write-Ok "Da co .env."
        if ($Force) { return }
        $ans = Read-Host "  Mo .env de chinh sua truoc khi chay? (y/N)"
        if ($ans -match '^(y|yes)$') {
            try { Start-Process notepad.exe -ArgumentList (Resolve-Path ".env").Path -Wait } catch {}
            Write-Ok "Da luu .env."
        }
        return
    }

    if ($example) {
        Write-Warn "Chua co .env. Tao tu $example."
        Copy-Item -LiteralPath $example -Destination ".env"
        if ($Force) { return }
        try { Start-Process notepad.exe -ArgumentList (Resolve-Path ".env").Path -Wait } catch {}
        Read-Host "  Nhan Enter sau khi luu .env de tiep tuc"
        Write-Ok "Da luu .env."
        return
    }

    Write-Warn "Khong tim thay .env hoac .env.example."
    if ($Force) { Write-Warn "-Force: bo qua buoc cau hinh."; return }

    Write-Host ""
    Write-Host "  Ban muon lam gi voi .env?" -ForegroundColor Cyan
    Write-Host "    [1] Tao .env trong roi mo Notepad tu dien"
    Write-Host "    [2] Tao .env tu dong tu cac bien da phat hien (mo Notepad)"
    Write-Host "    [3] Nhap tung bien ngay tai day"
    Write-Host "    [4] Bo qua (chay luon, co the app se loi)"
    $c = (Read-Host "  Chon [1-4]").Trim()

    switch ($c) {
        '1' {
            "" | Set-Content -LiteralPath ".env" -Encoding UTF8
            try { Start-Process notepad.exe -ArgumentList (Resolve-Path ".env").Path -Wait } catch {}
            Write-Ok "Da luu .env (trong)."
        }
        '2' {
            if ($detected.Count -eq 0) {
                "" | Set-Content -LiteralPath ".env" -Encoding UTF8
            } else {
                $lines = @("# Tu dong tao boi run-docker-app.ps1")
                foreach ($v in $detected) { $lines += "$v=" }
                ($lines -join "`r`n") | Set-Content -LiteralPath ".env" -Encoding UTF8
                Write-Ok "Da tao .env voi $($detected.Count) bien."
            }
            try { Start-Process notepad.exe -ArgumentList (Resolve-Path ".env").Path -Wait } catch {}
            Write-Ok "Da luu .env."
        }
        '3' {
            if ($detected.Count -eq 0) {
                $name = Read-Host "  Nhap ten bien (Enter de bo qua)"
                if ($name) {
                    $val = Read-Host "  Gia tri cho $name"
                    "$name=$val" | Set-Content -LiteralPath ".env" -Encoding UTF8
                    Write-Ok "Da luu .env."
                }
            } else {
                $pairs = @()
                Write-Dim "  (Enter de bo trong gia tri cua bien do)"
                foreach ($v in $detected) {
                    $val = Read-Host "  $v"
                    $pairs += "$v=$val"
                }
                ($pairs -join "`r`n") | Set-Content -LiteralPath ".env" -Encoding UTF8
                Write-Ok "Da luu .env voi $($pairs.Count) bien."
            }
        }
        '4' { Write-Warn "Bo qua cau hinh .env." }
        default { Write-Warn "Lua chon khong hop le - bo qua." }
    }
}

Invoke-EnvConfig

# =========================================================
#  6. BUILD + UP (v9: with auto-recovery)
# =========================================================
function Test-AnyContainerExited {
    $saved = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $raw = & docker compose @script:composeArgs ps --format json 2>$null
    } finally {
        $ErrorActionPreference = $saved
    }
    foreach ($l in ($raw -split "`r?`n")) {
        if (-not $l.Trim()) { continue }
        try {
            $j = $l | ConvertFrom-Json
            if ($j.State -and ($j.State -match '(?i)exited|dead|restarting')) {
                return $true
            }
        } catch {}
    }
    return $false
}

function Invoke-AutoRecovery {
    param([string]$Reason, [string[]]$OriginalFiles)
    Write-Step (T "RecoveryTitle")
    Write-Dim "  " + ((T "RecoveryReason") -f $Reason)

    Write-Warn (T "RecoveryLogsTitle")
    $saved = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & docker compose @script:composeArgs logs --tail=60 2>&1 | ForEach-Object { Write-LogLine $_ }
    } finally {
        $ErrorActionPreference = $saved
    }

    $primary = $OriginalFiles[0]
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = "$primary.failed-$stamp.bak"
    try {
        Copy-Item -LiteralPath $primary -Destination $backup -Force
        Write-Dim "  " + ((T "RecoveryBackup") -f $backup)
    } catch {}

    $autoName = "docker-compose.recovered.yml"
    $gen = New-AutoComposeFile -Root $PWD.Path -Name $autoName
    Write-Ok ((T "RecoveryComposeCreated") -f $gen.Path)

    Write-Host ""
    Write-Host "  " + (T "RecoveryComposeHeader") -ForegroundColor Cyan
    Get-Content -LiteralPath $gen.Path | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
    Write-Host ""
    Write-Warn "  >> Copy noi dung compose moi de len file goc de tiep tuc..."
    try {
        Copy-Item -LiteralPath $gen.Path -Destination $primary -Force
    } catch {
        Write-Err "Khong copy duoc: $($_.Exception.Message)"
        return $false
    }

    Write-Dim "  Dung container cu..."
    $saved = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & docker compose @script:composeArgs down 2>&1 | Out-Null
    } finally {
        $ErrorActionPreference = $saved
    }

    Write-Step (T "RecoveryRetry")
    $saved = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & docker compose @script:composeArgs up -d --build 2>&1 | ForEach-Object { Write-LogLine $_ }
    } finally {
        $ErrorActionPreference = $saved
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Err (T "RecoveryFailed")
        return $false
    }
    Start-Sleep -Seconds 3
    if (Test-AnyContainerExited) {
        Write-Err (T "RecoveryFailed")
        return $false
    }
    Write-Ok (T "RecoverySuccess")
    return $true
}

Write-Step "Build va khoi dong container..."
$saved = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
    & docker compose @script:composeArgs up -d --build 2>&1 | ForEach-Object { Write-LogLine $_ }
    $upCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $saved
}

$recovered = $false
if ($upCode -ne 0) {
    if (-not $NoAutoRecover) {
        $ok = Invoke-AutoRecovery -Reason ((T "UpFailed") -f $upCode) -OriginalFiles $ComposeFile
        if (-not $ok) { Fail ((T "UpFailed") -f $upCode) }
        $recovered = $true
    } else {
        Write-Err "docker compose up that bai. 80 dong log cuoi:"
        $saved = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try {
            & docker compose @script:composeArgs logs --tail=80 2>&1 | ForEach-Object { Write-LogLine $_ }
        } finally {
            $ErrorActionPreference = $saved
        }
        Fail "docker compose up that bai (exit code $upCode)."
    }
} else {
    Start-Sleep -Seconds 3
    if (Test-AnyContainerExited) {
        if (-not $NoAutoRecover) {
            $ok = Invoke-AutoRecovery -Reason "container exited after up" -OriginalFiles $ComposeFile
            if (-not $ok) { Fail (T "RecoveryFailed") }
            $recovered = $true
        } else {
            Write-Warn (T "RecoveryDisabled")
        }
    }
}

if (-not $recovered) {
    Write-Ok (T "UpSuccess")
}

# =========================================================
#  7. WAIT FOR CONTAINERS RUNNING
# =========================================================
function Get-ComposePsJson {
    $all = @()
    $saved = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $raw = & docker compose @script:composeArgs ps --format json 2>$null
    } finally {
        $ErrorActionPreference = $saved
    }
    $text = ($raw | Out-String).Trim()
    if (-not $text) { return ,$all }
    try {
        $parsed = $text | ConvertFrom-Json
        if ($parsed -is [array]) { return ,@($parsed) }
        elseif ($parsed) { return ,@($parsed) }
    } catch {
        foreach ($line in ($raw -split "`r?`n")) {
            if (-not $line.Trim()) { continue }
            try { $all += ($line | ConvertFrom-Json) } catch {}
        }
    }
    return ,$all
}

function Wait-ContainersRunning {
    param([int]$TimeoutSec = 60)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $last = @()
    while ((Get-Date) -lt $deadline) {
        $last = @(Get-ComposePsJson)
        if ($last.Count -gt 0) {
            $bad = @($last | Where-Object { $_.State -and $_.State -match '(?i)exited|dead|restarting|created' })
            if ($bad.Count -gt 0) {
                return [pscustomobject]@{ Ok=$false; Reason="co container exited/restarting"; All=$last }
            }
            $running = @($last | Where-Object { $_.State -and $_.State -match '(?i)running' })
            if ($running.Count -eq $last.Count) {
                return [pscustomobject]@{ Ok=$true; All=$last }
            }
        }
        Start-Sleep -Milliseconds 1000
    }
    return [pscustomobject]@{ Ok=$false; Reason="timeout cho container running"; All=$last }
}

Write-Step "Cho container running (toi da ${ReadyTimeoutSec}s)..."
$wait = Wait-ContainersRunning -TimeoutSec $ReadyTimeoutSec
if ($wait.Ok) {
    Write-Ok "Tat ca container da running."
} else {
    Write-Warn "Trang thai: $($wait.Reason)"
    foreach ($c in $wait.All) {
        Write-Host ("   - {0,-22} {1,-12} {2}" -f $c.Service, $c.State, $c.Status) -ForegroundColor DarkYellow
    }
    Write-Warn "Log 60 dong cuoi (chi dong loi to do):"
    $saved = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & docker compose @script:composeArgs logs --tail=60 2>&1 | ForEach-Object { Write-LogLine $_ }
    } finally {
        $ErrorActionPreference = $saved
    }
    Write-Host ""
    $ans = Read-Host "Van tiep tuc do port? (Y/n)"
    if ($ans -match '^(n|no)$') { exit 1 }
}

# =========================================================
#  8. DO PORT (4 FALLBACK + RETRY)
# =========================================================
function Get-ComposeGuessPorts {
    $out = @()
    foreach ($f in $ComposeFile) {
        $svc = "?"
        $inPorts = $false
        $read = Read-TextSafe -Path $f
        if (-not $read.Ok) { continue }
        foreach ($line in ($read.Text -split "`r?`n")) {
            if ($line -match '^\s{2}([A-Za-z0-9_\-]+)\s*:\s*$') { $svc = $Matches[1] }
            if ($line -match '^\s*ports\s*:') { $inPorts = $true; continue }
            if ($inPorts -and $line -match '^\s{0,4}\S' -and $line -notmatch '^\s*-\s') { $inPorts = $false }
            if ($inPorts -and $line -match '^\s*-\s*["'']?(?:(\d{1,3}(?:\.\d{1,3}){3})?:)?(\d{2,5}):(\d{2,5})["'']?') {
                $ip = if ($Matches[1]) { $Matches[1] } else { "127.0.0.1" }
                if ($ip -eq "0.0.0.0") { $ip = "127.0.0.1" }
                $out += [pscustomobject]@{
                    Service=$svc; HostIp=$ip
                    HostPort=[int]$Matches[2]; ContainerPort=[int]$Matches[3]
                }
            }
        }
    }
    return ,$out
}

function Get-PublishedPorts {
    $out = @()

    $psAll = @(Get-ComposePsJson)
    foreach ($obj in $psAll) {
        if ($obj.Publishers) {
            foreach ($p in $obj.Publishers) {
                if ($p.PublishedPort -and [int]$p.PublishedPort -ne 0) {
                    $out += [pscustomobject]@{
                        Service       = [string]$obj.Service
                        HostIp        = if ($p.URL -and $p.URL -ne "0.0.0.0") { [string]$p.URL } else { "127.0.0.1" }
                        HostPort      = [int]$p.PublishedPort
                        ContainerPort = if ($p.TargetPort) { [int]$p.TargetPort } else { 0 }
                    }
                }
            }
        }
    }
    if ($out.Count -gt 0) { return [pscustomobject]@{ Ports=$out; Tag="ps-json" } }

    try {
        $svcs = @(& docker compose @script:composeArgs config --services 2>$null) -split "`r?`n" |
            Where-Object { $_.Trim() -ne "" }
        foreach ($svc in $svcs) {
            $saved = $ErrorActionPreference
            $ErrorActionPreference = "Continue"
            try {
                $po = & docker compose @script:composeArgs port $svc 2>$null
            } finally {
                $ErrorActionPreference = $saved
            }
            if ($LASTEXITCODE -eq 0 -and $po) {
                foreach ($line in ($po -split "`r?`n")) {
                    if ($line -match '^(?:0\.0\.0\.0|127\.0\.0\.1|localhost|\[::\]):(\d+)$') {
                        $out += [pscustomobject]@{
                            Service=$svc; HostIp="127.0.0.1"
                            HostPort=[int]$Matches[1]; ContainerPort=0
                        }
                        break
                    }
                }
            }
        }
    } catch {}
    if ($out.Count -gt 0) { return [pscustomobject]@{ Ports=$out; Tag="compose-port" } }

    try {
        $ids = @(& docker compose @script:composeArgs ps -q 2>$null) -split "`r?`n" |
            Where-Object { $_.Trim() -ne "" }
        foreach ($id in $ids) {
            $json = & docker inspect $id 2>$null | Out-String
            try { $info = $json | ConvertFrom-Json } catch { continue }
            $svcName = ($info.Name -replace '^/','')
            if ($info.NetworkSettings -and $info.NetworkSettings.Ports) {
                foreach ($prop in $info.NetworkSettings.Ports.PSObject.Properties) {
                    $cPort = 0
                    if ($prop.Name -match '^(\d+)/') { $cPort = [int]$Matches[1] }
                    $bindings = @($prop.Value)
                    foreach ($b in $bindings) {
                        if ($b.HostPort) {
                            $ip = if ($b.HostIp -and $b.HostIp -ne "0.0.0.0") { $b.HostIp } else { "127.0.0.1" }
                            $out += [pscustomobject]@{
                                Service=$svcName; HostIp=$ip
                                HostPort=[int]$b.HostPort; ContainerPort=$cPort
                            }
                        }
                    }
                }
            }
        }
    } catch {}
    if ($out.Count -gt 0) { return [pscustomobject]@{ Ports=$out; Tag="inspect" } }

    $guess = @(Get-ComposeGuessPorts)
    if ($guess.Count -gt 0) {
        return [pscustomobject]@{ Ports=$guess; Tag="compose-file" }
    }

    return [pscustomobject]@{ Ports=@(); Tag="none" }
}

Write-Step "Do port published (retry 10 lan)..."
$detectResult = $null
for ($i = 1; $i -le 10; $i++) {
    $detectResult = Get-PublishedPorts
    if ($detectResult.Ports.Count -gt 0) {
        Write-Dim "   Lan $i : tim thay $($detectResult.Ports.Count) port (qua $($detectResult.Tag))"
        break
    }
    Write-Dim "   Lan $i : chua co, cho 1s..."
    Start-Sleep -Seconds 1
}

$ports     = @($detectResult.Ports)
$usedGuess = ($detectResult.Tag -eq "compose-file")

# =========================================================
#  9. LUON HIEN THI DIA CHI UI
# =========================================================
Write-Host ""
Write-Host "=============== DIA CHI UI CUA APP ===============" -ForegroundColor Cyan
if ($ports.Count -gt 0) {
    $seen = @{}
    foreach ($p in $ports) {
        $ip = if ($p.HostIp -in @("0.0.0.0","::")) { "127.0.0.1" } else { $p.HostIp }
        $u  = "http://${ip}:$($p.HostPort)/"
        if ($seen.ContainsKey($u)) { continue }
        $seen[$u] = $true
        $tag = if ($usedGuess) { "  (doan tu compose - co the sai)" } else { "" }
        Write-Host ("   $u   [$($p.Service)]$tag") -ForegroundColor White
    }
} else {
    Write-Host "   (khong doan duoc port - xem 'ports:' trong compose)" -ForegroundColor Yellow
}
Write-Host "==================================================" -ForegroundColor Cyan

# =========================================================
#  10. HTTP PROBE
# =========================================================
function Test-HttpEndpoint {
    param([string]$Url, [int]$TimeoutSec = 4)
    $r = [ordered]@{
        Url=$Url; Ok=$false; StatusCode=$null; Reason=""
        ContentType=""; Length=0; ElapsedMs=0; Snippet=""; Error=""
    }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $client = $null
    try {
        $handler = New-Object System.Net.Http.HttpClientHandler
        $handler.AllowAutoRedirect = $true
        $handler.UseCookies = $false
        $client = New-Object System.Net.Http.HttpClient($handler)
        $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSec)
        $client.DefaultRequestHeaders.Add("User-Agent","docker-app-healthcheck/1.0")
        $resp = $client.GetAsync($Url).GetAwaiter().GetResult()
        $r.StatusCode = [int]$resp.StatusCode
        $r.Reason     = $resp.ReasonPhrase
        if ($resp.Content -and $resp.Content.Headers.ContentType) {
            $r.ContentType = $resp.Content.Headers.ContentType.ToString()
        }
        $body = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        $r.Length = $body.Length
        if ($body.Length -gt 0) {
            $s = $body.Substring(0, [Math]::Min(240, $body.Length))
            $r.Snippet = ($s -replace '\s+',' ').Trim()
        }
        if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 400) { $r.Ok = $true }
    } catch {
        $ex = $_.Exception
        if ($ex.InnerException) { $ex = $ex.InnerException }
        $r.Error = $ex.Message
    } finally {
        if ($client) { $client.Dispose() }
    }
    $sw.Stop()
    $r.ElapsedMs = [int]$sw.ElapsedMilliseconds
    return [pscustomobject]$r
}

$appUrl = $null
$health = @()

if ($ports.Count -gt 0) {
    $urls = @($ports | ForEach-Object {
        $ip = if ($_.HostIp -in @("0.0.0.0","::")) { "127.0.0.1" } else { $_.HostIp }
        "http://${ip}:$($_.HostPort)/"
    } | Select-Object -Unique)

    Write-Step "Poll HTTP (toi da ${HealthTimeoutSec}s, ${urls.Count} URL)..."
    $deadline = (Get-Date).AddSeconds($HealthTimeoutSec)
    $attempt  = 0
    $lastByUrl = @{}
    while ((Get-Date) -lt $deadline) {
        $attempt++
        $okCount = 0
        foreach ($u in $urls) {
            $r = Test-HttpEndpoint -Url $u -TimeoutSec 3
            $lastByUrl[$u] = $r
            if ($r.Ok) { $okCount++ }
        }
        $color = if ($okCount -gt 0) { "Green" } else { "DarkGray" }
        Write-Host ("   [{0,2}] OK {1}/{2} endpoint" -f $attempt, $okCount, $urls.Count) -ForegroundColor $color
        if ($okCount -gt 0) { break }
        Start-Sleep -Milliseconds 2000
    }

    Write-Host ""
    Write-Host "========== TRANG THAI UI ==========" -ForegroundColor Cyan
    foreach ($p in $ports) {
        $ip = if ($p.HostIp -in @("0.0.0.0","::")) { "127.0.0.1" } else { $p.HostIp }
        $url = "http://${ip}:$($p.HostPort)/"
        $r = $lastByUrl[$url]
        if (-not $r) { $r = Test-HttpEndpoint -Url $url }
        $health += [pscustomobject]@{ Service=$p.Service; Url=$url; Result=$r }
        $st = if ($r.StatusCode) { "$($r.StatusCode) $($r.Reason)" } else { "khong phan hoi" }
        $line = "  {0,-12} {1,-26} {2,-20} {3,5}ms" -f $p.Service, $url, $st, $r.ElapsedMs
        if ($r.Ok) { Write-Host $line -ForegroundColor Green }
        else       { Write-Host $line -ForegroundColor Red }
    }
    Write-Host "===================================" -ForegroundColor Cyan

    $bad = @($health | Where-Object { -not $_.Result.Ok })
    if ($bad.Count -gt 0) {
        Write-Host ""
        Write-Warn "Mot so endpoint CHUA OK:"
        foreach ($h in $bad) {
            $r = $h.Result
            Write-Host "  $($h.Url)"
            if ($r.Error)       { Write-Host "     Loi ket noi: $($r.Error)" -ForegroundColor Red }
            if ($r.StatusCode)  { Write-Host "     HTTP $($r.StatusCode) $($r.Reason)" -ForegroundColor Red }
            if ($r.ContentType) { Write-Host "     Content-Type: $($r.ContentType)" -ForegroundColor DarkGray }
            if ($r.Snippet)     { Write-Host "     Body (dau): $($r.Snippet)" -ForegroundColor DarkGray }
        }
        Write-Host ""
        Write-Warn "Log 60 dong cuoi (chi dong loi to do):"
        $saved = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try {
            & docker compose @script:composeArgs logs --tail=60 2>&1 | ForEach-Object { Write-LogLine $_ }
        } finally {
            $ErrorActionPreference = $saved
        }
    }

    $primary = $health | Where-Object { $_.Result.Ok } | Select-Object -First 1
    if (-not $primary) { $primary = $health | Select-Object -First 1 }
    if ($primary) { $appUrl = $primary.Url }
}

# =========================================================
#  11. MO BROWSER + TU TEST LAI
# =========================================================
function Invoke-DeepDiagnostic {
    param([string]$Url)
    Write-Step "Chan doan sau"
    Write-Host "  URL kiem tra: $Url"
    Write-Host ""
    Write-Host "  --- Trang thai container ---" -ForegroundColor Cyan
    Invoke-Compose ps -a | ForEach-Object { Write-Host $_ }
    Write-Host ""
    Write-Host "  --- HTTP chi tiet ---" -ForegroundColor Cyan
    for ($i = 1; $i -le 3; $i++) {
        $r = Test-HttpEndpoint -Url $Url -TimeoutSec 5
        if ($r.Ok) {
            Write-Host "  Lan $i : OK  HTTP $($r.StatusCode) ($($r.ElapsedMs)ms)" -ForegroundColor Green
            return $true
        }
        $err = if ($r.Error) { $r.Error } else { "HTTP $($r.StatusCode) $($r.Reason)" }
        Write-Host "  Lan $i : FAIL  $err ($($r.ElapsedMs)ms)" -ForegroundColor Red
        if ($r.Snippet) { Write-Host "           Body: $($r.Snippet)" -ForegroundColor DarkGray }
        Start-Sleep -Seconds 2
    }
    Write-Host ""
    Write-Host "  --- Log 80 dong cuoi ---" -ForegroundColor Cyan
    $saved = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & docker compose @script:composeArgs logs --tail=80 2>&1 | ForEach-Object { Write-LogLine $_ }
    } finally {
        $ErrorActionPreference = $saved
    }
    return $false
}

$browserOpened = $false
$uiOk = ($health | Where-Object { $_.Url -eq $appUrl -and $_.Result.Ok } | Select-Object -First 1) -ne $null

if ($appUrl) {
    if ($uiOk) { Write-Ok "UI HOAT DONG: $appUrl" }
    else       { Write-Warn "UI CHUA OK: $appUrl" }

    if (-not $NoBrowser) {
        try {
            Start-Process $appUrl -ErrorAction Stop
            $browserOpened = $true
            Write-Ok "Da goi lenh mo trinh duyet."
        } catch {
            Write-Err "Khong mo duoc trinh duyet: $($_.Exception.Message)"
            $browserOpened = $false
        }

        if (-not $browserOpened -or -not $uiOk) {
            Write-Step "Tu dong kiem tra lai UI (retry 15 lan x 2s)..."
            $deadline = (Get-Date).AddSeconds(30)
            $nowOk = $false
            $tries = 0
            while ((Get-Date) -lt $deadline) {
                $tries++
                $r = Test-HttpEndpoint -Url $appUrl -TimeoutSec 4
                if ($r.Ok) {
                    Write-Host ("  [retry {0,2}] OK  HTTP {1} ({2}ms)" -f $tries, $r.StatusCode, $r.ElapsedMs) -ForegroundColor Green
                    $nowOk = $true
                    break
                } else {
                    $err = if ($r.Error) { $r.Error } else { "HTTP $($r.StatusCode) $($r.Reason)" }
                    Write-Host ("  [retry {0,2}] FAIL  {1}" -f $tries, $err) -ForegroundColor Red
                }
                Start-Sleep -Seconds 2
            }

            if ($nowOk) {
                Write-Ok "UI da san sang tro lai."
                if (-not $browserOpened) {
                    try {
                        Start-Process $appUrl -ErrorAction Stop
                        $browserOpened = $true
                        Write-Ok "Da mo trinh duyet sau retry."
                    } catch {
                        Write-Err "Van khong mo duoc trinh duyet: $($_.Exception.Message)"
                    }
                }
            } else {
                Write-Err "UI van khong phan hoi sau khi retry."
                [void](Invoke-DeepDiagnostic -Url $appUrl)
            }
        }
    }
} else {
    Write-Warn "Khong co URL nao de mo. Xem phan DIA CHI UI o tren va 'ports:' trong compose."
}

# =========================================================
#  12. WATCH LOG + MENU
# =========================================================
function Watch-Logs {
    Write-Step "Tail log real-time. Nhan [Q] de quay lai menu."
    $job = Start-Job -ScriptBlock {
        param($cwd, $argsList)
        Set-Location -LiteralPath $cwd
        & docker compose @argsList logs -f --tail=200 2>&1
    } -ArgumentList $PWD.Path, $script:composeArgs
    try {
        while ($true) {
            $lines = @(Receive-Job $job -ErrorAction SilentlyContinue)
            foreach ($l in $lines) { Write-LogLine $l }
            if ([Console]::KeyAvailable) {
                $k = [Console]::ReadKey($true)
                if ($k.Key -eq 'Q' -or $k.Key -eq 'Escape') { break }
            }
            Start-Sleep -Milliseconds 250
        }
    } finally {
        Stop-Job   $job -ErrorAction SilentlyContinue | Out-Null
        Remove-Job $job -Force      -ErrorAction SilentlyContinue | Out-Null
    }
    Write-Ok "Da thoat watch."
}

function Show-Diagnostics {
    Write-Host ""
    Write-Host "===== LENH CHAN DOAN NHANH =====" -ForegroundColor Cyan
    @(
        @{ K='Trang thai container';            C='docker compose ps' },
        @{ K='Moi container (ke ca stopped)';   C='docker compose ps -a' },
        @{ K='Log 200 dong cuoi';               C='docker compose logs --tail=200' },
        @{ K='Tail log real-time';              C='docker compose logs -f --tail=100' },
        @{ K='Log 1 service';                   C='docker compose logs -f <service>' },
        @{ K='Tai nguyen';                      C='docker stats' },
        @{ K='Liet ke image';                   C='docker images' },
        @{ K='Liet ke container (all)';         C='docker ps -a' },
        @{ K='Shell vao container';             C='docker compose exec <service> sh' },
        @{ K='Check config compose';            C='docker compose config' },
        @{ K='Port mapping 1 service';          C='docker compose port <service>' },
        @{ K='Inspect container';               C='docker inspect <container_id>' },
        @{ K='Restart 1 service';               C='docker compose restart <service>' },
        @{ K='Rebuild khong cache';             C='docker compose build --no-cache' },
        @{ K='Down + xoa volume (RESET)';       C='docker compose down -v' },
        @{ K='Prune toan bo docker';            C='docker system prune -af --volumes' }
    ) | ForEach-Object {
        Write-Host ("  {0,-42}" -f $_.K) -NoNewline -ForegroundColor Gray
        Write-Host $_.C -ForegroundColor White
    }
    Write-Host "================================" -ForegroundColor Cyan
}

function Invoke-HealthCheck {
    $d = Get-PublishedPorts
    $p = @($d.Ports)
    if ($p.Count -eq 0) { Write-Warn "Khong co port nao."; return }
    Write-Host ""
    Write-Host "========== KIEM TRA LAI UI ==========" -ForegroundColor Cyan
    foreach ($pp in $p) {
        $ip = if ($pp.HostIp -in @("0.0.0.0","::")) { "127.0.0.1" } else { $pp.HostIp }
        $url = "http://${ip}:$($pp.HostPort)/"
        $r = Test-HttpEndpoint -Url $url
        $st = if ($r.StatusCode) { "$($r.StatusCode) $($r.Reason)" } else { "khong phan hoi" }
        $line = "  {0,-12} {1,-26} {2,-20} {3,5}ms" -f $pp.Service, $url, $st, $r.ElapsedMs
        if ($r.Ok) { Write-Host $line -ForegroundColor Green }
        else {
            Write-Host $line -ForegroundColor Red
            if ($r.Error)   { Write-Host "     -> $($r.Error)"   -ForegroundColor Red }
            if ($r.Snippet) { Write-Host "     -> $($r.Snippet)" -ForegroundColor DarkGray }
        }
    }
    Write-Host "=====================================" -ForegroundColor Cyan
}

function Show-Menu {
    Write-Host ""
    Write-Host "============= MENU =============" -ForegroundColor Cyan
    Write-Host " [H] Kiem tra lai UI (HTTP health check)" -ForegroundColor White
    Write-Host " [L] Tail log real-time (highlight loi)" -ForegroundColor White
    Write-Host " [S] Trang thai container" -ForegroundColor White
    Write-Host " [E] Xem 200 dong log cuoi" -ForegroundColor White
    Write-Host " [R] Restart" -ForegroundColor White
    Write-Host " [U] Rebuild --no-cache + up lai" -ForegroundColor White
    Write-Host " [D] Dung app (down)" -ForegroundColor White
    Write-Host " [B] Mo lai trinh duyet" -ForegroundColor White
    Write-Host " [C] In bo lenh chan doan" -ForegroundColor White
    Write-Host " [F] Tu sua lai docker-compose" -ForegroundColor White
    Write-Host " [Q] Thoat (container van chay)" -ForegroundColor White
    Write-Host "================================" -ForegroundColor Cyan
    $composeInfo = ($ComposeFile -join ', ')
    $autoTag = if ($script:AutoCompose) { "  (AUTO)" } else { "" }
    Write-Host " Compose: $composeInfo$autoTag" -ForegroundColor DarkGray
    Write-Host " Lang: $script:Lang" -ForegroundColor DarkGray
    if ($appUrl) { Write-Host " UI: $appUrl" -ForegroundColor Green }
}

$running = $true
while ($running) {
    Show-Menu
    $choice = (Read-Host "Chon").Trim().ToUpper()
    switch ($choice) {
        'H' { Invoke-HealthCheck }
        'L' { Watch-Logs }
        'S' { Write-Host ""; Invoke-Compose ps -a | ForEach-Object { Write-Host $_ } }
        'E' {
            Write-Host ""
            $saved = $ErrorActionPreference
            $ErrorActionPreference = "Continue"
            try {
                & docker compose @script:composeArgs logs --tail=200 2>&1 | ForEach-Object { Write-LogLine $_ }
            } finally {
                $ErrorActionPreference = $saved
            }
        }
        'R' { Write-Step "Restart..."; Invoke-Compose restart }
        'U' {
            Write-Step "Rebuild --no-cache..."
            Invoke-Compose build --no-cache
            if ($LASTEXITCODE -eq 0) { Invoke-Compose up -d; Write-Ok "Da up lai." }
            else { Write-Err "build that bai." }
        }
        'D' {
            Write-Step "Dung va go container..."
            Invoke-Compose down
            Write-Ok "Da dung."
            $running = $false
        }
        'B' {
            if ($appUrl) {
                try { Start-Process $appUrl; Write-Ok "Da mo $appUrl" }
                catch { Write-Warn "Khong mo duoc: $($_.Exception.Message)" }
            } else { Write-Warn "Chua co URL." }
        }
        'C' { Show-Diagnostics }
        'F' {
            [void](Invoke-AutoFixCompose -Files $ComposeFile)
            Write-Warn "Nho [U] Rebuild de ap dung thay doi."
        }
        'Q' { $running = $false }
        default { Write-Warn "Lua chon khong hop le." }
    }
}

# =========================================================
#  KET THUC
# =========================================================
Write-Host ""
Write-Ok "Hoan tat. Container van chay duoi nen."
if ($appUrl) { Write-Host "  UI: $appUrl" -ForegroundColor Green }
Write-Host "  Down: .\run-docker-app.ps1 -Down" -ForegroundColor DarkGray
Write-Host "  Logs: .\run-docker-app.ps1 -Logs" -ForegroundColor DarkGray
Write-Host ""
Write-Host "Nhan Enter de dong..." -ForegroundColor DarkGray
[void](Read-Host)