#requires -Version 5.1
# =============================================================
#  GitHub ZIP -> Docker Image Publisher  (v4.0)
#  - 2 prompts only: ZIP + Repo
#  - Auth: auto via Git credential, else token
#  - Uploads, triggers GitHub Actions, returns image URL
# =============================================================

[CmdletBinding()]
param(
    [string]$ZipPath,
    [string]$RepoUrl,
    [string]$Token,
    [switch]$NoWait
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

# ------------------------------------------------------------
# Globals
# ------------------------------------------------------------
$script:ApiBase  = 'https://api.github.com'
$script:ApiVer   = '2022-11-28'
$script:Headers  = $null
$script:Owner    = $null
$script:Repo     = $null
$script:Branch   = 'main'
$script:TempDir  = $null
$script:Image    = $null
$script:RunId    = $null
$script:Started  = Get-Date
$script:Warns    = New-Object System.Collections.Generic.List[string]

# ------------------------------------------------------------
# Output helpers
# ------------------------------------------------------------
function Say   { param([string]$t) Write-Host $t }
function Blank { Write-Host "" }
function Ok    { param([string]$t) Write-Host ("[OK] " + $t) -ForegroundColor Green }
function Warn  { param([string]$t) $script:Warns.Add($t); Write-Host ("[!] " + $t) -ForegroundColor Yellow }
function Err   { param([string]$t) Write-Host ("[X] " + $t) -ForegroundColor Red }
function Info  { param([string]$t) Write-Host ("    " + $t) -ForegroundColor DarkGray }
function Die   { param([string]$t) throw $t }

function Ask {
    param([string]$Prompt, [string]$Default = "")
    if ($Default) {
        $r = (Read-Host ($Prompt + " [" + $Default + "]")).Trim()
        if ([string]::IsNullOrWhiteSpace($r)) { return $Default }
        return $r
    }
    return (Read-Host $Prompt).Trim()
}

# Step that prints one line, no partial-line glitches
function DoStep {
    param([string]$Label, [scriptblock]$Action)
    Write-Host ("[*] " + $Label + " ... ") -NoNewline -ForegroundColor Cyan
    try {
        $res = & $Action
        Write-Host "OK" -ForegroundColor Green
        return $res
    } catch {
        Write-Host "FAIL" -ForegroundColor Red
        throw
    }
}

# ------------------------------------------------------------
# Environment check
# ------------------------------------------------------------
function Check-Env {
    if ($PSVersionTable.PSVersion.Major -lt 5) {
        Die "PowerShell 5.1 or newer is required."
    }
    try {
        $null = Invoke-WebRequest -Uri 'https://api.github.com' `
            -Method Head -TimeoutSec 10 -UseBasicParsing -ErrorAction Stop
    } catch {
        if (-not $_.Exception.Response) {
            Die "Cannot reach api.github.com. Check your internet connection."
        }
    }
}

# ------------------------------------------------------------
# Git credential (no prompt)
# ------------------------------------------------------------
function Try-GitCredential {
    $g = Get-Command git -ErrorAction SilentlyContinue
    if (-not $g) { return $null }
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $env:GIT_TERMINAL_PROMPT = '0'
        $inputLines = "protocol=https`nhost=github.com`n`n"
        $out = $inputLines | & git credential fill 2>$null
        $rc  = $LASTEXITCODE
        if ($rc -ne 0 -or -not $out) { return $null }
        $line = @($out -split "`n" | Where-Object { $_ -match '^password=' })
        if ($line.Count -eq 0) { return $null }
        $pw = ($line[0] -replace '^password=','').Trim()
        if ($pw) { return $pw }
        return $null
    } catch {
        return $null
    } finally {
        Remove-Item Env:\GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue
        $ErrorActionPreference = $old
    }
}

# ------------------------------------------------------------
# Authentication
# ------------------------------------------------------------
function New-Headers {
    param([string]$T)
    return @{
        Authorization          = ("Bearer " + $T)
        Accept                 = 'application/vnd.github+json'
        'X-GitHub-Api-Version' = $script:ApiVer
        'User-Agent'           = 'GitHub-ZIP-Image-Publisher/4.0'
    }
}

function Test-Token {
    try {
        $r = Invoke-RestMethod -Uri ($script:ApiBase + "/user") `
             -Headers $script:Headers -TimeoutSec 15 -ErrorAction Stop
        $script:Owner = $r.login
        return $true
    } catch {
        return $false
    }
}

function Resolve-Auth {
    # 1) Token from parameter
    if ($Token) {
        $script:Headers = New-Headers $Token
        if (Test-Token) { return "token (provided)" }
        Die "The provided token is invalid."
    }

    # 2) Try Git credential (silent)
    $gitTok = Try-GitCredential
    if ($gitTok) {
        $script:Headers = New-Headers $gitTok
        if (Test-Token) { return "Git credential" }
    }

    # 3) Ask for PAT
    Blank
    Say "GitHub sign-in required."
    Say "  1. Open: https://github.com/settings/tokens"
    Say "  2. Create a token with scopes: repo, workflow, write:packages"
    Blank
    $sec = Read-Host "Paste GitHub token" -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { $pat = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }

    if ([string]::IsNullOrWhiteSpace($pat)) { Die "Token is empty." }
    $script:Headers = New-Headers $pat
    if (-not (Test-Token)) { Die "Token is invalid." }
    return "PAT"
}

# ------------------------------------------------------------
# REST client
# ------------------------------------------------------------
function Api {
    param(
        [string]$Method,
        [string]$Uri,
        [object]$Body,
        [int]$Retries = 5
    )
    $try = 0
    while ($true) {
        $try++
        try {
            $p = @{
                Method          = $Method
                Uri             = $Uri
                Headers         = $script:Headers
                TimeoutSec      = 45
                ErrorAction     = 'Stop'
                UseBasicParsing = $true
            }
            if ($null -ne $Body) {
                $p.ContentType = 'application/json; charset=utf-8'
                $p.Body        = ($Body | ConvertTo-Json -Depth 20 -Compress)
            }
            $r = Invoke-RestMethod @p
            return [pscustomobject]@{ Ok=$true; Data=$r; Status=200; Error=$null }
        } catch {
            $status     = 0
            $retryAfter = $null
            $raw        = $_.ErrorDetails.Message
            try {
                if ($_.Exception.Response) {
                    $status     = [int]$_.Exception.Response.StatusCode
                    $retryAfter = $_.Exception.Response.Headers['Retry-After']
                }
            } catch {}
            $transient = ($status -eq 408 -or $status -eq 409 -or $status -eq 429 -or $status -ge 500 -or $status -eq 0)
            if ($try -le $Retries -and $transient) {
                $d = 0
                if ($retryAfter -and ($retryAfter -as [int])) { $d = [int]$retryAfter }
                else { $d = [math]::Min(15, [math]::Pow(2, $try)) }
                Start-Sleep -Seconds $d
                continue
            }
            $msg = if ($raw) { $raw } else { $_.Exception.Message }
            return [pscustomobject]@{ Ok=$false; Data=$null; Status=$status; Error=$msg }
        }
    }
}

function Api-Err {
    param($R)
    if ($R.Error) {
        try {
            $j = $R.Error | ConvertFrom-Json
            if ($j.message) { return ("HTTP " + $R.Status + ": " + $j.message) }
        } catch {}
        return ("HTTP " + $R.Status + ": " + $R.Error)
    }
    return ("HTTP " + $R.Status)
}

# ------------------------------------------------------------
# ZIP handling
# ------------------------------------------------------------
function Expand-FullPath {
    param([string]$P)
    if ($P -like '~*') {
        return ($P -replace '^~', $env:USERPROFILE)
    }
    return $P
}

function Get-ZipFiles {
    param([string]$Path)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = $null
    try {
        $zip = [IO.Compression.ZipFile]::OpenRead($Path)
    } catch {
        Die ("Cannot open ZIP file: " + $_.Exception.Message)
    }
    try {
        $items = New-Object System.Collections.Generic.List[object]
        foreach ($e in $zip.Entries) {
            if ([string]::IsNullOrWhiteSpace($e.FullName)) { continue }
            if ($e.FullName.EndsWith('/')) { continue }
            $rel = $e.FullName.Replace('\','/')
            if ($rel.StartsWith('/') -or $rel -match '(^|/)\.\.?(/|$)' -or [IO.Path]::IsPathRooted($rel)) {
                Die ("Unsafe path inside ZIP: " + $rel)
            }
            $items.Add([pscustomobject]@{ Path=$rel })
        }
        if ($items.Count -eq 0) { Die "The ZIP file is empty." }
        return $items.ToArray()
    } finally {
        if ($zip) { $zip.Dispose() }
    }
}

function Expand-Zip {
    param([string]$ZipPath, [string]$Dest)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (Test-Path -LiteralPath $Dest) { Remove-Item -LiteralPath $Dest -Recurse -Force }
    New-Item -ItemType Directory -Path $Dest -Force | Out-Null
    $zip = [IO.Compression.ZipFile]::OpenRead($ZipPath)
    $n   = 0
    try {
        foreach ($e in $zip.Entries) {
            if ($e.FullName.EndsWith('/')) { continue }
            $rel  = $e.FullName.Replace('\','/')
            $tgt  = [IO.Path]::GetFullPath((Join-Path $Dest ($rel -replace '/', '\')))
            $root = [IO.Path]::GetFullPath($Dest).TrimEnd('\') + '\'
            if (-not $tgt.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) {
                Die ("Path escapes extraction folder: " + $rel)
            }
            $par = Split-Path $tgt -Parent
            if (-not (Test-Path -LiteralPath $par)) {
                New-Item -ItemType Directory -Path $par -Force | Out-Null
            }
            $in  = $e.Open()
            $out = [IO.File]::Open($tgt,[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::None)
            try { $in.CopyTo($out) } finally { $out.Dispose(); $in.Dispose() }
            $n++
        }
    } finally { $zip.Dispose() }
    return $n
}

function Get-Files {
    param([string]$Root)
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $all = Get-ChildItem -LiteralPath $rootFull -Recurse -File -Force
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($f in $all) {
        $rel = $f.FullName.Substring($rootFull.Length).TrimStart('\').Replace('\','/')
        if ($rel -match '(^|/)\.git(/|$)' -or
            $rel -match '(^|/)node_modules(/|$)' -or
            $rel -match '(^|/)(\.DS_Store|Thumbs\.db)$') {
            continue
        }
        $out.Add([pscustomobject]@{
            FullName = $f.FullName
            Path     = $rel
            Length   = $f.Length
        })
    }
    return $out.ToArray()
}

function Find-Root {
    param([string]$Dir)
    $items = Get-ChildItem -LiteralPath $Dir -Force
    $dirs  = @($items | Where-Object { $_.PSIsContainer })
    $files = @($items | Where-Object { -not $_.PSIsContainer })
    if ($dirs.Count -eq 1 -and $files.Count -eq 0) { return $dirs[0].FullName }
    return (Get-Item -LiteralPath $Dir).FullName
}

# ------------------------------------------------------------
# Dockerfile / Workflow
# ------------------------------------------------------------
function Find-Dockerfile {
    param([string]$R)
    $p1 = Join-Path $R 'Dockerfile'
    if (Test-Path -LiteralPath $p1 -PathType Leaf) { return $p1 }
    $p2 = Join-Path $R 'dockerfile'
    if (Test-Path -LiteralPath $p2 -PathType Leaf) { return $p2 }
    return $null
}

function New-Dockerfile {
    param([string]$R)
    if (Test-Path (Join-Path $R 'package.json')) {
        return (@(
            '# Auto-generated Dockerfile (Node.js)',
            'FROM node:20-alpine',
            'WORKDIR /app',
            'COPY package*.json ./',
            'RUN npm install --omit=dev || npm install',
            'COPY . .',
            'ENV NODE_ENV=production',
            'EXPOSE 3000',
            'CMD ["npm", "start"]'
        ) -join "`n")
    }
    if ((Test-Path (Join-Path $R 'requirements.txt')) -or
        (Test-Path (Join-Path $R 'pyproject.toml'))) {
        return (@(
            '# Auto-generated Dockerfile (Python)',
            'FROM python:3.12-slim',
            'WORKDIR /app',
            'COPY requirements.txt* ./',
            'RUN if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; fi',
            'COPY . .',
            'EXPOSE 8000',
            'CMD ["python", "app.py"]'
        ) -join "`n")
    }
    if (Test-Path (Join-Path $R 'go.mod')) {
        return (@(
            '# Auto-generated Dockerfile (Go)',
            'FROM golang:1.22-alpine AS build',
            'WORKDIR /src',
            'COPY . .',
            'RUN go build -o /out/app ./...',
            'FROM alpine:3.20',
            'COPY --from=build /out/app /app',
            'EXPOSE 8080',
            'ENTRYPOINT ["/app"]'
        ) -join "`n")
    }
    if (Test-Path (Join-Path $R 'index.html')) {
        return (@(
            '# Auto-generated Dockerfile (Static site via nginx)',
            'FROM nginx:alpine',
            'COPY . /usr/share/nginx/html',
            'EXPOSE 80'
        ) -join "`n")
    }
    return $null
}

function Ensure-Dockerfile {
    param([string]$R)
    $df = Find-Dockerfile $R
    if ($df) { return $df }

    $c = New-Dockerfile $R
    if (-not $c) {
        Warn "No Dockerfile found and app type is unknown."
        Blank
        Say "Please provide a Dockerfile path."
        $manual = Ask "Dockerfile path"
        if (-not $manual) { Die "No Dockerfile provided." }
        $manual = Expand-FullPath $manual.Trim('"').Trim()
        if (-not (Test-Path -LiteralPath $manual -PathType Leaf)) {
            Die ("File not found: " + $manual)
        }
        Copy-Item -LiteralPath $manual -Destination (Join-Path $R 'Dockerfile') -Force
        return (Join-Path $R 'Dockerfile')
    }
    Set-Content -LiteralPath (Join-Path $R 'Dockerfile') -Value $c -Encoding UTF8
    return (Join-Path $R 'Dockerfile')
}

function Get-WorkflowYaml {
    return (@(
        'name: Build Docker Image',
        '',
        'on:',
        '  push:',
        '    branches: [ main, master ]',
        '  workflow_dispatch:',
        '',
        'permissions:',
        '  contents: read',
        '  packages: write',
        '',
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: Checkout',
        '        uses: actions/checkout@v4',
        '',
        '      - name: Set up Buildx',
        '        uses: docker/setup-buildx-action@v3',
        '',
        '      - name: Login to GHCR',
        '        uses: docker/login-action@v3',
        '        with:',
        '          registry: ghcr.io',
        '          username: ${{ github.actor }}',
        '          password: ${{ secrets.GITHUB_TOKEN }}',
        '',
        '      - name: Docker metadata',
        '        id: meta',
        '        uses: docker/metadata-action@v5',
        '        with:',
        '          images: ghcr.io/${{ github.repository }}',
        '          tags: |',
        '            type=raw,value=latest,enable={{is_default_branch}}',
        '            type=ref,event=branch',
        '            type=sha,prefix=sha-',
        '',
        '      - name: Build and push',
        '        uses: docker/build-push-action@v6',
        '        with:',
        '          context: .',
        '          push: true',
        '          tags: ${{ steps.meta.outputs.tags }}',
        '          labels: ${{ steps.meta.outputs.labels }}',
        '          cache-from: type=gha',
        '          cache-to: type=gha,mode=max'
    ) -join "`n")
}

function Ensure-Workflow {
    param([string]$R)
    $dir = Join-Path $R '.github\workflows'
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $f = Join-Path $dir 'build-image.yml'
    if (-not (Test-Path -LiteralPath $f)) {
        Set-Content -LiteralPath $f -Value (Get-WorkflowYaml) -Encoding UTF8
    }
}

# ------------------------------------------------------------
# Repo name
# ------------------------------------------------------------
function Clean-RepoName {
    param([string]$N)
    $n = [IO.Path]::GetFileNameWithoutExtension($N)
    $n = [regex]::Replace($n, '\s*\(\d+\)$', '')
    $n = $n.Trim()
    $n = [regex]::Replace($n, '[^A-Za-z0-9._-]+', '-')
    $n = [regex]::Replace($n, '-{2,}', '-')
    $n = $n.Trim('-','.')
    if ([string]::IsNullOrWhiteSpace($n)) { $n = 'github-zip-project' }
    if ($n.Length -gt 100) { $n = $n.Substring(0,100).Trim('-','.') }
    return $n
}

# ------------------------------------------------------------
# Repo operations
# ------------------------------------------------------------
function Resolve-Repo {
    param([string]$Owner, [string]$Name)

    $r = Api GET ($script:ApiBase + "/repos/" + $Owner + "/" + $Name)
    if ($r.Ok) {
        return [pscustomobject]@{
            Name   = $Name
            Web    = ("https://github.com/" + $Owner + "/" + $Name)
            Exists = $true
        }
    }
    if ($r.Status -ne 404) { Die (Api-Err $r) }

    $body = @{
        name        = $Name
        private     = $false
        auto_init   = $true
        description = 'Published by ZIP Image Publisher'
    }
    $c = Api POST ($script:ApiBase + "/user/repos") $body
    if (-not $c.Ok) { Die ("Could not create repository: " + (Api-Err $c)) }
    return [pscustomobject]@{
        Name   = $Name
        Web    = $c.Data.html_url
        Exists = $false
    }
}

function Get-RepoMeta {
    param([string]$Owner, [string]$Name)
    for ($i = 0; $i -lt 30; $i++) {
        $r = Api GET ($script:ApiBase + "/repos/" + $Owner + "/" + $Name)
        if ($r.Ok) { return $r.Data }
        Start-Sleep -Seconds 2
    }
    Die "Repository is not ready after 60 seconds."
}

function Enable-WorkflowWrite {
    param([string]$Owner, [string]$Name)
    $body = @{
        default_workflow_permissions     = 'write'
        can_approve_pull_request_reviews = $false
    }
    $r = Api PUT ($script:ApiBase + "/repos/" + $Owner + "/" + $Name + "/actions/permissions/workflow") $body
    if (-not $r.Ok) {
        Warn "Could not enable workflow write permission automatically. You may need to enable it in Settings > Actions > General."
    }
}

# ------------------------------------------------------------
# Upload
# ------------------------------------------------------------
function Encode-Path {
    param([string]$P)
    $parts = ($P).Replace('\','/').Split('/')
    return (($parts | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/')
}

function Is-Workflow {
    param([string]$P)
    return ($P -replace '\\','/') -match '^(?i)\.github/workflows/'
}

function Upload-Files {
    param([string]$Owner, [string]$Repo, [string]$Branch, $Files)

    $total   = $Files.Count
    $ordered = @($Files | Sort-Object @{Expression={ if (Is-Workflow $_.Path) { 0 } else { 1 } }}, Path)

    $n = 0
    foreach ($f in $ordered) {
        if ($f.Length -gt 100MB) {
            Die ("File exceeds 100 MB limit: " + $f.Path)
        }
        $bytes = [IO.File]::ReadAllBytes($f.FullName)
        $b64   = [Convert]::ToBase64String($bytes)
        $uri   = $script:ApiBase + "/repos/" + $Owner + "/" + $Repo + "/contents/" + (Encode-Path $f.Path)

        $ex = Api GET ($uri + "?ref=" + [uri]::EscapeDataString($Branch))
        $body = @{
            message = ("Publish " + $f.Path)
            content = $b64
            branch  = $Branch
        }
        if ($ex.Ok -and $ex.Data.sha) { $body.sha = $ex.Data.sha }
        elseif ($ex.Status -ne 404) {
            Die ("Cannot read " + $f.Path + ": " + (Api-Err $ex))
        }

        $put = Api PUT $uri $body
        if (-not $put.Ok -and $put.Status -eq 409) {
            Start-Sleep -Seconds 2
            $ex2 = Api GET ($uri + "?ref=" + [uri]::EscapeDataString($Branch))
            if ($ex2.Ok -and $ex2.Data.sha) { $body.sha = $ex2.Data.sha }
            $put = Api PUT $uri $body
        }
        if (-not $put.Ok) {
            if ($put.Status -eq 404 -and (Is-Workflow $f.Path)) {
                Die ("Workflow file rejected. Your token needs the 'workflow' scope. File: " + $f.Path)
            }
            Die ("Upload failed: " + $f.Path + " -> " + (Api-Err $put))
        }
        $n++
        # Print progress every 5 files or on last
        if (($n % 5) -eq 0 -or $n -eq $total) {
            Info ("Uploaded " + $n + "/" + $total)
        }
    }
    return $n
}

# ------------------------------------------------------------
# Wait for build
# ------------------------------------------------------------
function Get-Run {
    param([string]$Owner, [string]$Repo, [string]$Branch, [datetime]$Since)
    $uri = $script:ApiBase + "/repos/" + $Owner + "/" + $Repo +
           "/actions/runs?branch=" + [uri]::EscapeDataString($Branch) + "&per_page=20"
    $r = Api GET $uri
    if (-not $r.Ok) { return $null }
    $runs = @($r.Data.workflow_runs)
    if ($runs.Count -eq 0) { return $null }
    # Filter by our workflow file and by time
    $f = @($runs | Where-Object {
        try {
            ([datetime]$_.created_at -ge $Since) -and
            ($_.path -match 'build-image\.ya?ml$')
        } catch { $false }
    })
    if ($f.Count -eq 0) { return $null }
    return ($f | Sort-Object { [datetime]$_.created_at } -Descending)[0]
}

function Wait-Build {
    param([string]$Owner, [string]$Repo, [string]$Branch, [datetime]$Since, [int]$MaxMin = 20)

    $deadline = (Get-Date).AddMinutes($MaxMin)

    # Find the run
    $run = $null
    for ($i = 0; $i -lt 40; $i++) {
        if ((Get-Date) -ge $deadline) { Die "Build did not start within the time limit." }
        $run = Get-Run $Owner $Repo $Branch $Since
        if ($run) { break }
        Start-Sleep -Seconds 5
    }
    if (-not $run) { Die "Could not find the workflow run. Open the Actions tab on GitHub." }
    $script:RunId = $run.id

    # Poll
    $t0     = Get-Date
    $lastSt = ""
    while ($run.status -ne 'completed') {
        if ((Get-Date) -ge $deadline) {
            Die ("Build did not finish in time. Status: " + $run.status)
        }
        Start-Sleep -Seconds 8
        $r = Api GET ($script:ApiBase + "/repos/" + $Owner + "/" + $Repo +
                      "/actions/runs/" + $run.id)
        if ($r.Ok) { $run = $r.Data }

        $el = [int]((Get-Date) - $t0).TotalSeconds
        if ($run.status -ne $lastSt) {
            Info ("Build status: " + $run.status + " (" + $el + "s)")
            $lastSt = $run.status
        }
    }

    $el = [int]((Get-Date) - $t0).TotalSeconds
    Info ("Build finished in " + $el + "s: " + $run.conclusion)
    return $run
}

function Show-BuildError {
    param([string]$Owner, [string]$Repo, [long]$RunId)

    $r = Api GET ($script:ApiBase + "/repos/" + $Owner + "/" + $Repo +
                  "/actions/runs/" + $RunId + "/jobs")
    if (-not $r.Ok) { return }
    foreach ($j in $r.Data.jobs) {
        if ($j.conclusion -eq 'failure' -or $j.conclusion -eq 'cancelled' -or $j.conclusion -eq 'timed_out') {
            Err ("Job failed: " + $j.name + " (" + $j.conclusion + ")")
            Info ("Log: " + $j.html_url)
            foreach ($s in $j.steps) {
                if ($s.conclusion -eq 'failure') {
                    Err ("  Step " + $s.number + ": " + $s.name)
                }
            }
        }
    }
}

# =============================================================
# Main
# =============================================================
function Main {
    Say "========================================================="
    Say "   GitHub ZIP -> Docker Image Publisher"
    Say "========================================================="
    Blank

    # ---- 1. ZIP ----
    if (-not $ZipPath) {
        while ($true) {
            $ZipPath = Ask "ZIP file path"
            if ([string]::IsNullOrWhiteSpace($ZipPath)) { Warn "Please enter a path."; continue }
            $ZipPath = Expand-FullPath ($ZipPath.Trim('"').Trim())
            if (-not (Test-Path -LiteralPath $ZipPath -PathType Leaf)) { Warn "File not found."; continue }
            if (-not ([IO.Path]::GetExtension($ZipPath) -ieq '.zip')) { Warn "Not a .zip file."; continue }
            break
        }
    } else {
        $ZipPath = Expand-FullPath ($ZipPath.Trim('"').Trim())
        if (-not (Test-Path -LiteralPath $ZipPath -PathType Leaf)) {
            Die ("File not found: " + $ZipPath)
        }
        if (-not ([IO.Path]::GetExtension($ZipPath) -ieq '.zip')) {
            Die "Input is not a .zip file."
        }
    }

    $defaultName = Clean-RepoName ([IO.Path]::GetFileNameWithoutExtension($ZipPath))

    # ---- 2. Repo ----
    if (-not $RepoUrl) {
        Blank
        Say "GitHub repository"
        Say "  - Paste a full URL:  https://github.com/user/repo"
        Say "  - Or type a new name to create a repository under your account"
        Blank
        $RepoUrl = Ask "Repository" $defaultName
    }

    # ---- Env ----
    $null = DoStep "Checking environment" { Check-Env }

    # ---- Auth ----
    $authKind = DoStep "Signing in to GitHub" { Resolve-Auth }
    Info ("User: " + $script:Owner + " (" + $authKind + ")")

    # ---- Parse repo ----
    $rurl = $RepoUrl -replace '[?#].*$',''
    $rurl = $rurl.TrimEnd('/')

    $targetOwner = $null
    $targetName  = $null

    if ($rurl -match '^https?://') {
        if ($rurl -notmatch '^https://github\.com/([^/]+)/([^/]+?)(?:\.git)?$') {
            Die ("Invalid GitHub URL: " + $RepoUrl)
        }
        $targetOwner = $Matches[1]
        $targetName  = $Matches[2]
    } else {
        $targetOwner = $script:Owner
        $targetName  = Clean-RepoName $rurl
    }

    # ---- Extract ----
    $extract = DoStep "Extracting ZIP" {
        $script:TempDir = Join-Path ([IO.Path]::GetTempPath()) ('ghzip-' + [guid]::NewGuid().ToString('N'))
        $null = Get-ZipFiles $ZipPath
        $n = Expand-Zip -ZipPath $ZipPath -Dest $script:TempDir
        return $n
    }
    Info ($extract.ToString() + " files extracted")

    $root = Find-Root $script:TempDir
    $null = Ensure-Dockerfile $root
    $null = Ensure-Workflow   $root

    $files = @(Get-Files $root)
    if ($files.Count -eq 0) { Die "No files to upload after filtering." }

    # ---- Repo + Workflow permission ----
    $repoInfo = DoStep "Preparing repository" {
        $ri = Resolve-Repo -Owner $targetOwner -Name $targetName
        $m  = Get-RepoMeta -Owner $targetOwner -Name $targetName
        if ($m.default_branch) { $script:Branch = $m.default_branch } else { $script:Branch = 'main' }
        Enable-WorkflowWrite -Owner $targetOwner -Name $targetName
        return $ri
    }
    $script:Owner = $targetOwner
    $script:Repo  = $targetName
    Info ("https://github.com/" + $targetOwner + "/" + $targetName + " (branch: " + $script:Branch + ")")

    # ---- Upload ----
    $uploadStart = Get-Date
    $null = DoStep ("Uploading " + $files.Count + " files") {
        Upload-Files -Owner $targetOwner -Repo $targetName -Branch $script:Branch -Files $files
    }

    if ($NoWait) {
        Blank
        Ok "Upload complete. Build skipped (--NoWait)."
        Info ("Actions: https://github.com/" + $targetOwner + "/" + $targetName + "/actions")
        return
    }

    # ---- Wait ----
    Start-Sleep -Seconds 5
    $run = DoStep "Waiting for build" {
        Wait-Build -Owner $targetOwner -Repo $targetName -Branch $script:Branch -Since $uploadStart -MaxMin 20
    }

    if ($run.conclusion -ne 'success') {
        Blank
        Err ("Build failed: " + $run.conclusion)
        Show-BuildError -Owner $targetOwner -Repo $targetName -RunId $run.id
        Blank
        Info ("Full log: https://github.com/" + $targetOwner + "/" + $targetName + "/actions/runs/" + $run.id)
        Die "The workflow did not succeed."
    }

    $script:Image = "ghcr.io/" + $targetOwner + "/" + $targetName + ":latest"
}

# =============================================================
# Entry
# =============================================================
try {
    Main

    $elapsed = [int]((Get-Date) - $script:Started).TotalSeconds
    Blank
    Say "========================================================="
    Write-Host "   SUCCESS" -ForegroundColor Green
    Say "========================================================="
    Say ("Repository : https://github.com/" + $script:Owner + "/" + $script:Repo)
    Write-Host ("Image      : " + $script:Image) -ForegroundColor Green
    Say ("Time       : " + $elapsed + "s")
    Blank
    Say "Use it with:"
    Write-Host ("  docker pull " + $script:Image) -ForegroundColor Cyan
    Write-Host ("  docker run --rm -p 8080:3000 " + $script:Image) -ForegroundColor Cyan
    Blank
    Say "Note: GHCR packages are private by default."
    Say ("Make it public: https://github.com/users/" + $script:Owner +
        "/packages/container/" + $script:Repo + "/settings")
    Say "========================================================="

    if ($script:Warns.Count) {
        Blank
        Say "Warnings:" -ForegroundColor Yellow
        $script:Warns | Select-Object -Unique | ForEach-Object {
            Say ("  - " + $_) -ForegroundColor Yellow
        }
    }
}
catch {
    Blank
    Say "========================================================="
    Write-Host "   ERROR" -ForegroundColor Red
    Say "========================================================="
    Err $_.Exception.Message
    if ($script:RunId -and $script:Owner -and $script:Repo) {
        Blank
        Info ("Build log: https://github.com/" + $script:Owner + "/" + $script:Repo +
              "/actions/runs/" + $script:RunId)
    }
    if ($script:Warns.Count) {
        Blank
        Say "Warnings:" -ForegroundColor Yellow
        $script:Warns | Select-Object -Unique | ForEach-Object {
            Say ("  - " + $_) -ForegroundColor Yellow
        }
    }
    Say "========================================================="
}
finally {
    if ($script:TempDir -and (Test-Path -LiteralPath $script:TempDir)) {
        try {
            Remove-Item -LiteralPath $script:TempDir -Recurse -Force -ErrorAction SilentlyContinue
        } catch {}
    }
}

Read-Host "`nPress Enter to exit"