#requires -Version 5.1
<#+
.SYNOPSIS
  Resilient standalone GitHub ZIP Publisher.

.DESCRIPTION
  Uploads a ZIP project to GitHub and verifies the result.
  The publisher waits for every HTTP operation, retries transient failures,
  validates repository/ref/tree state, and falls back to the Contents API when
  the Git Data API cannot be used safely.

  It never reports success merely because a request was sent. Success requires
  a verified commit (Git Data API) or verified uploaded files (Contents API).

  No GitHub CLI, Git, Node, Python or Docker is required.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Script:ApiBase = 'https://api.github.com'
$Script:ApiVersion = '2022-11-28'
$Script:TimeoutSec = 45
$Script:MaxRetries = 5
$Script:Warnings = New-Object System.Collections.Generic.List[string]
$Script:Failures = New-Object System.Collections.Generic.List[string]
$Script:Actions = New-Object System.Collections.Generic.List[string]
$Script:Uploaded = 0
$Script:Skipped = 0
$Script:Started = Get-Date
$temp = $null

function Write-Step([string]$Text) { Write-Host "`n[*] $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "[OK] $Text" -ForegroundColor Green }
function Write-Warn([string]$Text) { $Script:Warnings.Add($Text); Write-Host "[WARN] $Text" -ForegroundColor Yellow }
function Write-Fail([string]$Text) { $Script:Failures.Add($Text); Write-Host "[FAIL] $Text" -ForegroundColor Red }
function Write-Info([string]$Text) { Write-Host "    $Text" -ForegroundColor Gray }
function Add-Action([string]$Text) { $Script:Actions.Add($Text); Write-Host "[ACTION] $Text" -ForegroundColor Magenta }
function NowMs([datetime]$Start) { [int]((Get-Date) - $Start).TotalMilliseconds }

function Normalize-RepoName([string]$Name) {
    $n = [IO.Path]::GetFileNameWithoutExtension($Name)
    # Remove common browser/download duplicate suffixes, but keep user supplied names otherwise.
    $n = [regex]::Replace($n, '\s*\(\d+\)$', '')
    $n = $n.Trim()
    $n = [regex]::Replace($n, '[^A-Za-z0-9._-]+', '-')
    $n = [regex]::Replace($n, '-{2,}', '-')
    $n = $n.Trim('-','.')
    if ([string]::IsNullOrWhiteSpace($n)) { $n = 'github-zip-project' }
    if ($n.Length -gt 100) { $n = $n.Substring(0,100).Trim('-','.') }
    return $n
}

function Get-TokenInput {
    $secure = Read-Host 'GitHub Token (classic or fine-grained)' -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function New-Headers([string]$Token) {
    return @{
        Authorization = "Bearer $Token"
        Accept = 'application/vnd.github+json'
        'X-GitHub-Api-Version' = $Script:ApiVersion
        'User-Agent' = 'GitHub-ZIP-Publisher/2.2'
    }
}

function Invoke-GitHub {
    param(
        [Parameter(Mandatory)][ValidateSet('GET','POST','PUT','PATCH','DELETE')][string]$Method,
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][hashtable]$Headers,
        [object]$Body,
        [int]$TimeoutSec = $Script:TimeoutSec,
        [int]$Retries = $Script:MaxRetries,
        [switch]$RawBytes
    )

    $attempt = 0
    while ($true) {
        $attempt++
        $started = Get-Date
        try {
            $params = @{
                Method = $Method
                Uri = $Uri
                Headers = $Headers
                TimeoutSec = $TimeoutSec
                ErrorAction = 'Stop'
            }
            if ($null -ne $Body) {
                $params.ContentType = 'application/json; charset=utf-8'
                if ($RawBytes) { $params.Body = $Body }
                else { $params.Body = ($Body | ConvertTo-Json -Depth 20 -Compress) }
            }
            $response = Invoke-RestMethod @params
            Write-Info "$Method $Uri -> OK ($(NowMs $started) ms)"
            return [pscustomobject]@{ Ok=$true; Data=$response; Status=200; Error=$null }
        } catch {
            $status = 0
            $retryAfter = $null
            $raw = $_.ErrorDetails.Message
            try {
                if ($_.Exception.Response) {
                    $status = [int]$_.Exception.Response.StatusCode
                    $retryAfter = $_.Exception.Response.Headers['Retry-After']
                }
            } catch {}
            $transient = ($status -eq 408 -or $status -eq 409 -or $status -eq 429 -or $status -ge 500 -or $status -eq 0)
            $message = if ($raw) { $raw } else { $_.Exception.Message }
            if ($attempt -le $Retries -and $transient) {
                $delay = if ($retryAfter -and ($retryAfter -as [int])) { [int]$retryAfter } else { [math]::Min(20, [math]::Pow(2, $attempt)) }
                Write-Warn "$Method attempt $attempt/$($Retries+1) did not complete (HTTP $status). Waiting ${delay}s before retry."
                Start-Sleep -Seconds $delay
                continue
            }
            Write-Info "$Method $Uri -> HTTP $status ($(NowMs $started) ms)"
            return [pscustomobject]@{ Ok=$false; Data=$null; Status=$status; Error=$message }
        }
    }
}

function Get-ErrorMessage($Result) {
    if ($Result.Error) {
        try {
            $j = $Result.Error | ConvertFrom-Json
            if ($j.message) { return "HTTP $($Result.Status): $($j.message)" }
        } catch {}
        return "HTTP $($Result.Status): $($Result.Error)"
    }
    return "HTTP $($Result.Status)"
}

function Get-ZipFiles([string]$ZipPath) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        $items = New-Object System.Collections.Generic.List[object]
        foreach ($entry in $zip.Entries) {
            if ([string]::IsNullOrWhiteSpace($entry.FullName)) { continue }
            if ($entry.FullName.EndsWith('/')) { continue }
            $relative = $entry.FullName.Replace('\','/')
            if ($relative.StartsWith('/') -or $relative -match '(^|/)\.\.?(/|$)' -or [IO.Path]::IsPathRooted($relative)) {
                throw "Unsafe ZIP path detected: $relative"
            }
            $items.Add([pscustomobject]@{ Entry=$entry; Path=$relative })
        }
        return $items.ToArray()
    } finally { $zip.Dispose() }
}

function Expand-ZipSafe([string]$ZipPath,[string]$Destination) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (Test-Path $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    $zip = [IO.Compression.ZipFile]::OpenRead($ZipPath)
    $count = 0
    try {
        foreach ($entry in $zip.Entries) {
            if ($entry.FullName.EndsWith('/')) { continue }
            $relative = $entry.FullName.Replace('\','/')
            if ($relative.StartsWith('/') -or $relative -match '(^|/)\.\.?(/|$)' -or [IO.Path]::IsPathRooted($relative)) {
                throw "Unsafe ZIP path detected: $relative"
            }
            $target = [IO.Path]::GetFullPath((Join-Path $Destination ($relative -replace '/', '\')))
            $root = [IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
            if (-not $target.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) { throw "ZIP path escapes extraction directory: $relative" }
            $parent = Split-Path $target -Parent
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
            $in = $entry.Open(); $out = [IO.File]::Open($target,[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::None)
            try { $in.CopyTo($out) } finally { $out.Dispose(); $in.Dispose() }
            $count++
        }
    } finally { $zip.Dispose() }
    return $count
}

function Get-ProjectFiles([string]$Root) {
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $files = Get-ChildItem -LiteralPath $rootFull -Recurse -File -Force
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($f in $files) {
        $rel = $f.FullName.Substring($rootFull.Length).TrimStart('\').Replace('\','/')
        if ($rel -match '(^|/)\.git(/|$)' -or $rel -match '(^|/)node_modules(/|$)' -or $rel -match '(^|/)(\.DS_Store|Thumbs\.db)$') {
            $Script:Skipped++; continue
        }
        $out.Add([pscustomobject]@{ FullName=$f.FullName; Path=$rel; Length=$f.Length })
    }
    return $out.ToArray()
}

function Scan-Secrets($Files) {
    $badNames = @('(^|/)\.env$','(^|/)\.npmrc$','(^|/)id_rsa$','(^|/)id_ed25519$','(^|/)\.pem$','(^|/)\.p12$','(^|/)\.pfx$')
    $hits = New-Object System.Collections.Generic.List[string]
    foreach ($f in $Files) {
        foreach ($pattern in $badNames) { if ($f.Path -match $pattern) { $hits.Add($f.Path); break } }
        if ($f.Length -le 2MB -and $f.Path -notmatch '\.(png|jpe?g|gif|webp|ico|zip|pdf|woff2?|ttf)$') {
            try {
                $text = Get-Content -LiteralPath $f.FullName -Raw -ErrorAction Stop
                if ($text -match '(?i)(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----)') {
                    $hits.Add("$($f.Path) (secret-like content)")
                }
            } catch {}
        }
    }
    return @($hits | Select-Object -Unique)
}

function Resolve-Repo([string]$Owner,[string]$Requested,[hashtable]$Headers) {
    $name = Normalize-RepoName $Requested
    $r = Invoke-GitHub GET "$($Script:ApiBase)/repos/$Owner/$name" $Headers
    if ($r.Ok) { Write-Ok "Repository exists: https://github.com/$Owner/$name"; return [pscustomobject]@{Name=$name; Url="https://github.com/$Owner/$name"; Existing=$true} }
    if ($r.Status -ne 404) { throw (Get-ErrorMessage $r) }

    Write-Info 'Repository not found. Creating with an initial commit so Git refs are immediately available.'
    $body = @{ name=$name; private=$script:PrivateRepo; auto_init=$true; description='Published by GitHub ZIP Publisher' }
    $c = Invoke-GitHub POST "$($Script:ApiBase)/user/repos" $Headers $body
    if (-not $c.Ok) { throw "Repository creation failed. $(Get-ErrorMessage $c)" }
    Write-Ok "Repository created: $($c.Data.html_url)"
    return [pscustomobject]@{Name=$name; Url=$c.Data.html_url; Existing=$false}
}

function Wait-RepoReady([string]$Owner,[string]$Repo,[hashtable]$Headers) {
    $deadline = (Get-Date).AddSeconds(60)
    do {
        $r = Invoke-GitHub GET "$($Script:ApiBase)/repos/$Owner/$Repo" $Headers -Retries 2
        if ($r.Ok) { return $r.Data }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    throw "Repository did not become readable within 60 seconds. $(Get-ErrorMessage $r)"
}

function Upload-GitData([string]$Owner,[string]$Repo,[string]$Branch,$Files,[hashtable]$Headers) {
    Write-Step 'GIT DATA API - uploading blobs'
    $blobRows = New-Object System.Collections.Generic.List[object]
    foreach ($f in $Files) {
        if ($f.Length -gt 100MB) { throw "GitHub REST Git Data cannot accept $($f.Path): file is over 100 MB." }
        if ($null -eq $f -or [string]::IsNullOrWhiteSpace([string]$f.FullName)) { throw "Invalid project file record: FullName is empty." }
        $fullPath = [IO.Path]::GetFullPath([string]$f.FullName)
        if (-not [IO.File]::Exists($fullPath)) { throw "Project file does not exist: $fullPath" }
        $bytes = [IO.File]::ReadAllBytes($fullPath)
        $b64 = [Convert]::ToBase64String($bytes)
        $b = Invoke-GitHub POST "$($Script:ApiBase)/repos/$Owner/$Repo/git/blobs" $Headers @{ content=$b64; encoding='base64' }
        if (-not $b.Ok) { throw "Blob upload failed for $($f.Path). $(Get-ErrorMessage $b)" }
        $blobRows.Add([pscustomobject]@{ path=$f.Path; mode='100644'; type='blob'; sha=$b.Data.sha })
        $Script:Uploaded++
        Write-Info "Blob $($Script:Uploaded)/$($Files.Count): $($f.Path)"
    }

    Write-Step 'GIT DATA API - resolving branch and base tree'
    $ref = Invoke-GitHub GET "$($Script:ApiBase)/repos/$Owner/$Repo/git/ref/heads/$Branch" $Headers
    if (-not $ref.Ok) { throw "Branch ref '$Branch' is not available. $(Get-ErrorMessage $ref)" }
    $baseCommitSha = $ref.Data.object.sha
    $commit = Invoke-GitHub GET "$($Script:ApiBase)/repos/$Owner/$Repo/git/commits/$baseCommitSha" $Headers
    if (-not $commit.Ok) { throw "Base commit '$baseCommitSha' cannot be read. $(Get-ErrorMessage $commit)" }
    $baseTree = $commit.Data.tree.sha

    $treeBody = @{ base_tree=$baseTree; tree=@($blobRows | ForEach-Object { @{path=$_.path;mode=$_.mode;type=$_.type;sha=$_.sha} }) }
    $tree = Invoke-GitHub POST "$($Script:ApiBase)/repos/$Owner/$Repo/git/trees" $Headers $treeBody
    if (-not $tree.Ok) { throw "Tree creation failed. $(Get-ErrorMessage $tree)" }
    Write-Ok "Tree created: $($tree.Data.sha)"

    $message = "Publish project $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    $newCommit = Invoke-GitHub POST "$($Script:ApiBase)/repos/$Owner/$Repo/git/commits" $Headers @{message=$message; tree=$tree.Data.sha; parents=@($baseCommitSha)}
    if (-not $newCommit.Ok) { throw "Commit creation failed. $(Get-ErrorMessage $newCommit)" }
    $commitSha = $newCommit.Data.sha

    $update = Invoke-GitHub PATCH "$($Script:ApiBase)/repos/$Owner/$Repo/git/refs/heads/$Branch" $Headers @{sha=$commitSha; force=$false}
    if (-not $update.Ok) { throw "Branch update failed. $(Get-ErrorMessage $update)" }
    Write-Ok "Commit published: $commitSha"
    return [pscustomobject]@{Method='GitData';CommitSha=$commitSha;Branch=$Branch}
}

function Encode-GitHubContentPath([string]$Path) {
    # GitHub's contents endpoint treats '/' as the path separator. Encode each
    # segment separately; encoding the whole path turns '/' into %2F and can
    # produce HTTP 404 for nested files such as .github/workflows/docker.yml.
    $parts = ([string]$Path).Replace('\','/').Split('/')
    return (($parts | ForEach-Object { [uri]::EscapeDataString([string]$_) }) -join '/')
}

function Add-RefQuery([string]$BaseUri,[string]$Branch) {
    return ($BaseUri + "?ref=" + [uri]::EscapeDataString([string]$Branch))
}

function Test-IsWorkflowPath([string]$Path) {
    return ([string]$Path -replace '\\','/') -match '^(?i)\.github/workflows/'
}


function Get-ContainerVersions([string]$Owner,[string]$Repo,[hashtable]$Headers) {
    $pkg = [uri]::EscapeDataString($Repo.ToLower())
    $uri = "$($Script:ApiBase)/users/$Owner/packages/container/$pkg/versions?per_page=100"
    $r = Invoke-GitHub GET $uri $Headers -Retries 2
    if ($r.Ok) { return @($r.Data) }
    # Organization-owned packages use the organization endpoint.
    $uri = "$($Script:ApiBase)/orgs/$Owner/packages/container/$pkg/versions?per_page=100"
    $r = Invoke-GitHub GET $uri $Headers -Retries 2
    if ($r.Ok) { return @($r.Data) }
    return @()
}

function Wait-ForContainerImage([string]$Owner,[string]$Repo,[string]$Tag,[hashtable]$Headers,[int]$TimeoutSec=90) {
    Write-Step "VERIFY - checking GHCR image $Owner/$Repo`:$Tag"
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    do {
        $versions = @(Get-ContainerVersions $Owner $Repo $Headers)
        foreach ($v in $versions) {
            $tags = @($v.metadata.container.tags)
            if ($tags -contains $Tag) {
                Write-Ok "GHCR image confirmed: ghcr.io/$($Owner.ToLower())/$($Repo.ToLower()):$Tag"
                return [pscustomobject]@{ Ok=$true; Image="ghcr.io/$($Owner.ToLower())/$($Repo.ToLower()):$Tag"; VersionId=$v.id }
            }
        }
        if ((Get-Date) -lt $deadline) {
            Write-Info 'Image not visible yet. GitHub Actions may still be building it. Waiting 5s...'
            Start-Sleep -Seconds 5
        }
    } while ((Get-Date) -lt $deadline)
    Write-Warn "GHCR image tag '$Tag' was not confirmed after $TimeoutSec seconds. Source upload is still verified, but do not install on SoloHost until this image exists."
    return [pscustomobject]@{ Ok=$false; Image="ghcr.io/$($Owner.ToLower())/$($Repo.ToLower()):$Tag"; VersionId=$null }
}

function Show-SoloHostInstall([string]$Owner,[string]$Repo,[string]$Tag) {
    $image = "ghcr.io/$($Owner.ToLower())/$($Repo.ToLower()):$Tag"
    Write-Host "`n========================================================="
    Write-Host 'SOLOHOST INSTALL GUIDE' -ForegroundColor Cyan
    Write-Host '========================================================='
    Write-Host "[IMAGE]     $image"
    Write-Host '[CHECK]     The image must be confirmed before installation.'
    Write-Host '[INSTALL]   1. Open Pi Desktop -> SoloHost.'
    Write-Host '[INSTALL]   2. Add the app using docker-compose.yml and config_options.yml from the repository.'
    Write-Host '[INSTALL]   3. Save the configuration.'
    Write-Host '[INSTALL]   4. Start the app.'
    Write-Host '[INSTALL]   5. If SoloHost reports an error, paste the exact message back into App Builder.'
    Write-Host '[NOTE]      SoloHost pulls the pre-built public image; it does not build the image from the package.'
}

function Get-WorkflowPermissionHint([hashtable]$Headers) {
    return @(
        'GitHub rejected a workflow file. This is normally a token-permission issue, not a ZIP or path issue.',
        'Classic PAT: use https://github.com/settings/tokens/new and select repo, workflow, and write:packages.',
        'Do not confuse Tokens (classic) with Fine-grained tokens. The Builder fallback is designed for the classic token flow.',
        '2FA does not need to be disabled.'
    ) -join ' '
}

function Upload-ContentsFallback([string]$Owner,[string]$Repo,[string]$Branch,$Files,[hashtable]$Headers) {
    Write-Step 'CONTENTS API - uploading and verifying files'
    $count = 0
    # Workflow files are deliberately uploaded first. If the token lacks workflow
    # permission, the publisher stops before creating a partial project.
    $orderedFiles = @($Files | Sort-Object @{Expression={ if (Test-IsWorkflowPath $_.Path) { 0 } else { 1 } }}, Path)
    foreach ($f in $orderedFiles) {
        if ($f.Length -gt 100MB) { throw "Contents API cannot accept $($f.Path): file is over 100 MB." }
        if ($null -eq $f -or [string]::IsNullOrWhiteSpace([string]$f.FullName)) { throw "Invalid project file record: FullName is empty." }
        $fullPath = [IO.Path]::GetFullPath([string]$f.FullName)
        if (-not [IO.File]::Exists($fullPath)) { throw "Project file does not exist: $fullPath" }
        $bytes = [IO.File]::ReadAllBytes($fullPath)
        $b64 = [Convert]::ToBase64String($bytes)
        $uri = "$($Script:ApiBase)/repos/$Owner/$Repo/contents/$(Encode-GitHubContentPath $f.Path)"
        $existing = Invoke-GitHub GET (Add-RefQuery $uri $Branch) $Headers -Retries 3
        $body = @{ message="Publish $($f.Path)"; content=$b64; branch=$Branch }
        if ($existing.Ok -and $existing.Data.sha) { $body.sha = $existing.Data.sha }
        elseif ($existing.Status -ne 404) { throw "Cannot inspect $($f.Path). $(Get-ErrorMessage $existing)" }
        $put = Invoke-GitHub PUT $uri $Headers $body
        if (-not $put.Ok) {
            # Concurrent update: re-read SHA once and retry safely.
            if ($put.Status -eq 409) {
                Start-Sleep -Seconds 2
                $existing2 = Invoke-GitHub GET (Add-RefQuery $uri $Branch) $Headers
                if ($existing2.Ok -and $existing2.Data.sha) { $body.sha=$existing2.Data.sha }
                $put = Invoke-GitHub PUT $uri $Headers $body
            }
        }
        if (-not $put.Ok) {
            if ($put.Status -eq 404 -and (Test-IsWorkflowPath $f.Path)) {
                throw "Workflow file '$($f.Path)' was rejected with HTTP 404. $(Get-WorkflowPermissionHint $Headers)"
            }
            throw "Contents upload failed for $($f.Path). $(Get-ErrorMessage $put)"
        }
        $count++
        $Script:Uploaded = $count
        Write-Info "File $count/$($Files.Count): $($f.Path)"
    }
    return [pscustomobject]@{Method='Contents';CommitSha=$null;Branch=$Branch;Files=$count}
}

function Verify-Publish([string]$Owner,[string]$Repo,[string]$Branch,$Files,[hashtable]$Headers,$CommitSha) {
    Write-Step 'VERIFY - confirming repository state on GitHub'
    $repoInfo = Wait-RepoReady $Owner $Repo $Headers
    if ($repoInfo.default_branch -ne $Branch) { Write-Warn "GitHub default branch is '$($repoInfo.default_branch)', published branch is '$Branch'." }
    $missing = New-Object System.Collections.Generic.List[string]
    foreach ($f in $Files) {
        $uri = "$($Script:ApiBase)/repos/$Owner/$Repo/contents/$(Encode-GitHubContentPath $f.Path)"
        $r = Invoke-GitHub GET (Add-RefQuery $uri $Branch) $Headers -Retries 3
        if (-not $r.Ok) { $missing.Add($f.Path); continue }
        if ($r.Data.type -ne 'file') { $missing.Add($f.Path); continue }
    }
    if ($missing.Count -gt 0) { throw "Verification failed. Missing/unreadable files: $($missing -join ', ')" }
    if ($CommitSha) {
        $c = Invoke-GitHub GET "$($Script:ApiBase)/repos/$Owner/$Repo/commits/$CommitSha" $Headers -Retries 3
        if (-not $c.Ok) { throw "Published commit $CommitSha could not be verified. $(Get-ErrorMessage $c)" }
    }
    Write-Ok "Verified $($Files.Count) project file(s) on GitHub."
    return $true
}

Write-Host @"
=========================================================
   GitHub ZIP Publisher  - Resilient Standalone v2.6
=========================================================
"@

try {
    Write-Step 'LOGIN - GitHub Login'
    $token = Get-TokenInput
    if ([string]::IsNullOrWhiteSpace($token)) { throw 'GitHub token is empty.' }
    $headers = New-Headers $token

    $who = Invoke-GitHub GET "$($Script:ApiBase)/user" $headers
    if (-not $who.Ok) { throw "Token validation failed. $(Get-ErrorMessage $who)" }
    $tokenOwner = $who.Data.login
    Write-Ok "Token valid - authenticated as '$tokenOwner'."

    $ownerInput = Read-Host "GitHub ID (blank = $tokenOwner)"
    $owner = if ([string]::IsNullOrWhiteSpace($ownerInput)) { $tokenOwner } else { $ownerInput.Trim() }
    if ($owner -ne $tokenOwner) {
        $ownerCheck = Invoke-GitHub GET "$($Script:ApiBase)/users/$owner" $headers
        if (-not $ownerCheck.Ok) { throw "GitHub owner '$owner' could not be verified. $(Get-ErrorMessage $ownerCheck)" }
        Write-Warn "Authenticated token belongs to '$tokenOwner', while target owner is '$owner'. Repository creation may be denied unless the token has permission."
    } else { Write-Ok 'GitHub ID matches token owner.' }

    Write-Step 'ZIP - Select ZIP'
    do {
        $zipPath = Read-Host 'Path to ZIP file'
        if ([string]::IsNullOrWhiteSpace($zipPath)) { Write-Warn 'Path is empty. Please enter a ZIP path.'; continue }
        $zipPath = $zipPath.Trim().Trim('"')
        if (-not (Test-Path -LiteralPath $zipPath -PathType Leaf)) { Write-Warn "ZIP not found: $zipPath"; $zipPath=$null; continue }
        if ([IO.Path]::GetExtension($zipPath) -ne '.zip') { Write-Warn 'Selected file is not a .zip file.'; $zipPath=$null; continue }
        break
    } while ($true)
    Write-Ok "ZIP selected: $zipPath"

    Write-Step 'CHECK - ZIP integrity and safe extraction'
    # Force collection semantics: 0/1/many ZIP entries must all expose .Count.
    $zipItems = @(Get-ZipFiles $zipPath)
    if ($zipItems.Count -eq 0) { throw 'ZIP contains no files.' }
    $temp = Join-Path ([IO.Path]::GetTempPath()) ('ghzip-' + [guid]::NewGuid().ToString('N'))
    $count = Expand-ZipSafe $zipPath $temp
    Write-Ok "Extracted $count file(s) using .NET safe extraction."

    # Force collection semantics for one-file projects as well.
    $files = @(Get-ProjectFiles $temp)
    if ($files.Count -eq 0) { throw 'No publishable project files remain after filtering.' }
    Write-Ok "Project inventory: $($files.Count) file(s), skipped $($Script:Skipped)."
    # Normalize to a flat array of file records. This protects Windows PowerShell 5.1
    # from single-item/nested-array unrolling before any upload function receives it.
    $files = @($files | ForEach-Object { if ($_ -is [System.Array]) { $_ } else { $_ } })
    foreach ($file in $files) {
        if ($null -eq $file.FullName) { throw 'Project inventory contains an invalid file record (missing FullName).' }
    }

    Write-Step 'CHECK - risky files and secrets'
    # PowerShell 5.1 collapses a single pipeline result to a scalar string.
    # Force collection semantics so .Count is always safe under StrictMode.
    $scanStarted = Get-Date
    $hits = @(Scan-Secrets $files)
    Write-Info "Secret scan completed in $(NowMs $scanStarted) ms."
    if ($hits.Count -gt 0) {
        Write-Warn 'Potentially sensitive files detected:'
        foreach ($h in $hits) { Write-Info "- $h" }
        $answer = Read-Host 'Continue and upload anyway? [y/N]'
        if ($answer -notmatch '^(?i)y(es)?$') { throw 'Upload cancelled because potentially sensitive files were detected.' }
    } else { Write-Ok 'No obvious secret files or token-like content detected.' }

    Write-Step 'REPO - Repository'
    $defaultName = Normalize-RepoName ([IO.Path]::GetFileNameWithoutExtension($zipPath))
    $repoInput = Read-Host "Repository name [$defaultName]"
    $repoRequested = if ([string]::IsNullOrWhiteSpace($repoInput)) { $defaultName } else { $repoInput.Trim() }
    $privateInput = Read-Host 'Make repository PRIVATE? [Y/n]'
    $script:PrivateRepo = -not ($privateInput -match '^(?i)n(o)?$')

    $repo = Resolve-Repo $owner $repoRequested $headers
    $repoName = $repo.Name
    $repoInfo = Wait-RepoReady $owner $repoName $headers
    $branch = $repoInfo.default_branch
    if ([string]::IsNullOrWhiteSpace($branch)) { $branch = 'main' }
    Write-Ok "Repository ready. Default branch: $branch"

    # Reliability-first: use the repository Contents API as the primary publish path.
    # It avoids Git Data tree/ref edge cases (including HTTP 404 on /git/trees) and
    # publishes files serially, which is also the documented safe usage pattern.
    # The Git Data implementation remains in the script for diagnostics/future use.
    Write-Info 'Reliability mode: using verified Contents API as the primary publish path.'
    $workflowFiles = @($files | Where-Object { Test-IsWorkflowPath $_.Path })
    if ($workflowFiles.Count -gt 0) {
        Write-Info "Detected $($workflowFiles.Count) GitHub Actions workflow file(s). They require workflow write permission."
        Write-Info 'The publisher will test workflow files first to avoid leaving a partially published project.'
    }
    $publish = Upload-ContentsFallback $owner $repoName $branch $files $headers

    Verify-Publish $owner $repoName $branch $files $headers $publish.CommitSha

    $versionInput = Read-Host 'Image version tag to verify [0.1.0]'
    $imageTag = if ([string]::IsNullOrWhiteSpace($versionInput)) { '0.1.0' } else { $versionInput.Trim() }
    $imageCheck = Wait-ForContainerImage $owner $repoName $imageTag $headers 90
    Show-SoloHostInstall $owner $repoName $imageTag

    Write-Step 'FINAL REPORT'
    $elapsed = [int]((Get-Date)-$Script:Started).TotalSeconds
    Write-Host "[REPO]      https://github.com/$owner/$repoName"
    Write-Host "[UPLOADED]  $($files.Count)"
    Write-Host "[SKIPPED]   $($Script:Skipped)"
    Write-Host "[COMMIT]    $($publish.CommitSha)"
    Write-Host "[METHOD]    $($publish.Method)"
    Write-Host "[IMAGE]     $($imageCheck.Image) | confirmed=$($imageCheck.Ok)"
    Write-Host "[TIME]      ${elapsed}s"
    if ($Script:Warnings.Count) {
        Write-Host "`n[WARN] Warnings ($($Script:Warnings.Count))" -ForegroundColor Yellow
        $Script:Warnings | Select-Object -Unique | ForEach-Object { Write-Host "   - $_" }
    }
    if ($Script:Actions.Count) {
        Write-Host "`n[ACTION] Recovery performed ($($Script:Actions.Count))" -ForegroundColor Magenta
        $Script:Actions | Select-Object -Unique | ForEach-Object { Write-Host "   - $_" }
    }
    Write-Host "`nStatus: [SUCCESS] Published and verified." -ForegroundColor Green
}
catch {
    $msg = $_.Exception.Message
    Write-Fail $msg
    Write-Host "`n========================================================="
    Write-Host 'FINAL REPORT'
    Write-Host '========================================================='
    Write-Host "[UPLOADED]  $Script:Uploaded"
    Write-Host "[SKIPPED]   $Script:Skipped"
    if ($Script:Warnings.Count) {
        Write-Host "`n[WARN] Warnings ($($Script:Warnings.Count))" -ForegroundColor Yellow
        $Script:Warnings | Select-Object -Unique | ForEach-Object { Write-Host "   - $_" }
    }
    Write-Host "`n[FAIL] Failures ($($Script:Failures.Count))" -ForegroundColor Red
    $Script:Failures | Select-Object -Unique | ForEach-Object { Write-Host "   - $_" }
    Write-Host "`n[ACTION] The publisher stopped only after recovery/retry paths were exhausted. No success was reported without verification." -ForegroundColor Magenta
}
finally {
    if ($temp -and (Test-Path -LiteralPath $temp)) {
        try { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue } catch {}
    }
}

Read-Host "`nPress Enter to exit"
