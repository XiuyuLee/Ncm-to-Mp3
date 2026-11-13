<#
.SYNOPSIS
    把 dsh-ncm2mp3 插件包发布（创建仓库并首次推送）到 GitHub。

.DESCRIPTION
    工作流程：
      1. 定位包根目录（本脚本位于 <包根>/scripts/ 下）；
      2. 用便携 git 初始化本地仓库、确保提交身份、git add -A 并 commit；
      3. 调 GitHub REST API 校验 PAT、确认/创建远端仓库；
      4. push 时通过 "http.extraHeader: Authorization: Basic ..." 携带凭据：
         token 不写入 .git/config、不写入 remote URL、不落盘；push 结束后
         remote 始终保持为不带 token 的 https 地址；
      5. 输出仓库网页地址。

    PowerShell 5.1 兼容（不使用 ?? / 三元运算符），不需要管理员权限。

.PARAMETER Token
    GitHub Personal Access Token。
      - classic PAT：勾选 repo scope（可创建仓库 + 写入代码）；
      - fine-grained PAT：仓库需先在网页创建；权限 Contents = Read and write、
        Metadata = Read。fine-grained token 一般无法创建仓库。
    安全提醒：不要把 token 写进脚本/文件；用命令行传入或运行时交互输入。
    使用 -DryRun 演练时可不提供。

.PARAMETER Owner
    仓库所属账号或组织，默认取 token 对应用户的 login。
    注意：本脚本只支持在 token 所属账号下自动创建仓库；若 -Owner 是组织/他人，
    请先在 GitHub 网页手动创建仓库（或换用组织端点）。

.PARAMETER Repo
    仓库名，默认 dsh-ncm2mp3。

.PARAMETER Private
    创建为私有仓库（默认公开）。

.PARAMETER DryRun
    只打印将执行的 git / API 操作，不执行、不联网、不改 .git。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish-github.ps1 -Token "ghp_xxx"

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish-github.ps1 -Token "ghp_xxx" -Private

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish-github.ps1 -DryRun

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish-github.ps1 -Token "ghp_xxx" -Owner myname -Repo dsh-ncm2mp3
#>
[CmdletBinding()]
param(
    [string]$Token = '',
    [string]$Owner = '',
    [string]$Repo = 'dsh-ncm2mp3',
    [switch]$Private,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$script:GitExe = ''
$script:RepoRoot = ''
$script:Version = ''
$script:RepoUrl = ''
$script:BasicAuth = ''
$script:ExitCode = 0
$script:GitFound = $false

$ApiBase = 'https://api.github.com'

# ---------- 输出与工具函数 ----------

function Write-Step {
    param([string]$Text)
    Write-Host ''
    Write-Host "==> $Text" -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$Text)
    Write-Host "    [OK] $Text" -ForegroundColor Green
}

function Write-Note {
    param([string]$Text)
    Write-Host "    $Text"
}

function Write-WarnLine {
    param([string]$Text)
    Write-Host "    [警告] $Text" -ForegroundColor Yellow
}

function Hide-Secret {
    param([string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return $Text }
    $result = $Text
    if (-not [string]::IsNullOrEmpty($script:BasicAuth)) {
        $result = $result.Replace($script:BasicAuth, '<BASIC-AUTH>')
    }
    if (-not [string]::IsNullOrEmpty($Token)) {
        $result = $result.Replace($Token, '<TOKEN>')
    }
    return $result
}

function Format-GitArgs {
    param([string[]]$Arguments)
    $parts = @()
    foreach ($arg in $Arguments) {
        $a = [string]$arg
        if ($a -match '[\s"]') {
            $parts += ('"' + $a + '"')
        } else {
            $parts += $a
        }
    }
    return ($parts -join ' ')
}

function Convert-RawGitOutput {
    # 把 2>&1 捕获的混合输出规整为纯文本（去掉 PowerShell 的 ErrorRecord 装饰）
    param([object[]]$Raw)
    $lines = @()
    foreach ($item in $Raw) {
        if ($null -eq $item) { continue }
        if ($item -is [System.Management.Automation.ErrorRecord]) {
            $message = $item.Exception.Message
            if ($null -ne $message) {
                foreach ($line in ($message -split "`r?`n")) { $lines += $line }
            }
        } else {
            $textItem = [string]$item
            foreach ($line in ($textItem -split "`r?`n")) { $lines += $line }
        }
    }
    return (($lines -join "`n").TrimEnd())
}

function Invoke-Git {
    param(
        [string[]]$Arguments,
        [switch]$AllowFailure,
        [switch]$Quiet
    )
    $oldEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $raw = & $script:GitExe @Arguments 2>&1
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $oldEap
    }
    $text = Convert-RawGitOutput $raw
    $text = Hide-Secret $text
    if ($text -ne '' -and -not $Quiet) { Write-Note $text }
    if ($code -ne 0 -and -not $AllowFailure) {
        throw "git 命令失败（exit code $code）：git $(Format-GitArgs $Arguments)"
    }
    return [pscustomobject]@{ Code = $code; Output = $text }
}

function Invoke-GitPlanned {
    param(
        [string[]]$Arguments,
        [string]$Display = '',
        [switch]$AllowFailure
    )
    if ($DryRun) {
        if ($Display -ne '') {
            Write-Note "[DryRun] $Display"
        } else {
            Write-Note ("[DryRun] git " + (Format-GitArgs $Arguments))
        }
        return [pscustomobject]@{ Code = 0; Output = '' }
    }
    return (Invoke-Git -Arguments $Arguments -AllowFailure:$AllowFailure)
}

function Invoke-GitHubApi {
    param(
        [string]$Method,
        [string]$Path,
        [object]$Body = $null
    )
    $headers = @{
        'Authorization' = "token $Token"
        'User-Agent'    = 'dsh-ncm2mp3-publish-script'
        'Accept'        = 'application/vnd.github+json'
    }
    $requestParams = @{
        Uri         = ($ApiBase + $Path)
        Method      = $Method
        Headers     = $headers
        UseBasicParsing = $true
        TimeoutSec  = 60
    }
    if ($null -ne $Body) {
        $requestParams['ContentType'] = 'application/json'
        $requestParams['Body'] = ($Body | ConvertTo-Json -Depth 4 -Compress)
    }
    try {
        $data = Invoke-RestMethod @requestParams
        return [pscustomobject]@{ Ok = $true; Status = 200; Data = $data; Message = '' }
    } catch {
        $status = 0
        $serverBody = ''
        $response = $null
        if ($null -ne $_.Exception.Response) { $response = $_.Exception.Response }
        if ($null -ne $response) {
            try { $status = [int]$response.StatusCode } catch { $status = 0 }
            try {
                $stream = $response.GetResponseStream()
                $reader = New-Object System.IO.StreamReader($stream)
                $serverBody = $reader.ReadToEnd()
                $reader.Close()
            } catch { $serverBody = '' }
        }
        $message = $_.Exception.Message
        return [pscustomobject]@{ Ok = $false; Status = $status; Data = $null; Message = $message; ServerBody = $serverBody }
    }
}

# ---------- 主流程 ----------

Write-Host '==============================================' -ForegroundColor White
Write-Host '  dsh-ncm2mp3 -> GitHub 发布脚本' -ForegroundColor White
Write-Host '==============================================' -ForegroundColor White
if ($DryRun) {
    Write-WarnLine '-DryRun 模式：只打印操作计划，不执行 git 写操作、不联网。'
}

try {
    # ---- 0. 参数与目录 ----
    if ([string]::IsNullOrWhiteSpace($Repo)) {
        throw '-Repo 不能为空。'
    }
    if (-not $DryRun -and [string]::IsNullOrWhiteSpace($Token)) {
        throw '-Token 必填：GitHub Personal Access Token（需要 repo 写权限）。想先演练可加 -DryRun。'
    }

    $scriptDir = $PSScriptRoot
    if ([string]::IsNullOrWhiteSpace($scriptDir)) {
        throw '无法确定脚本所在目录：请用 powershell -File <路径>\publish-github.ps1 方式运行。'
    }
    $script:RepoRoot = Split-Path -Parent $scriptDir
    $packageJson = Join-Path $script:RepoRoot 'package.json'
    if (-not (Test-Path -LiteralPath $packageJson)) {
        throw "仓库根目录定位失败：$packageJson 不存在。本脚本应放在 <包根>/scripts/ 目录下运行。"
    }
    $pkg = $null
    try {
        $pkg = Get-Content -LiteralPath $packageJson -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        throw "package.json 解析失败：$($_.Exception.Message)"
    }
    $script:Version = [string]$pkg.version
    if ([string]::IsNullOrWhiteSpace($script:Version)) {
        throw 'package.json 中缺少 version 字段，无法生成发布提交信息。'
    }
    $pkgDescription = ''
    if ($null -ne $pkg.description) { $pkgDescription = [string]$pkg.description }
    if ([string]::IsNullOrWhiteSpace($pkgDescription)) { $pkgDescription = "DeepSeek Harness plugin: $Repo" }
    if ($pkgDescription.Length -gt 350) { $pkgDescription = $pkgDescription.Substring(0, 350) }
    $isPrivate = $Private.IsPresent

    Write-Step '发布信息'
    Write-Note "包根目录 : $script:RepoRoot"
    Write-Note "仓库名   : $Repo"
    Write-Note "版本     : v$script:Version"
    if ($isPrivate) { Write-Note '可见性   : 私有' } else { Write-Note '可见性   : 公开' }

    # ---- 1. 定位便携 git ----
    Write-Step '定位 git'
    $toolsParent = Split-Path -Parent $script:RepoRoot
    $gitCandidates = @(
        (Join-Path $toolsParent '.tools\git\cmd\git.exe'),
        (Join-Path $toolsParent '.tools\git\mingw64\bin\git.exe'),
        (Join-Path $toolsParent '.tools\git\bin\git.exe')
    )
    foreach ($candidate in $gitCandidates) {
        if (Test-Path -LiteralPath $candidate) {
            $script:GitExe = (Resolve-Path -LiteralPath $candidate).Path
            break
        }
    }
    if ([string]::IsNullOrWhiteSpace($script:GitExe)) {
        $gitCmd = Get-Command git -ErrorAction SilentlyContinue
        if ($null -ne $gitCmd -and -not [string]::IsNullOrWhiteSpace($gitCmd.Source)) {
            $script:GitExe = $gitCmd.Source
        }
    }
    if ([string]::IsNullOrWhiteSpace($script:GitExe)) {
        if ($DryRun) {
            $script:GitExe = 'git'
            Write-WarnLine '未找到 git.exe；-DryRun 继续用占位符打印计划。'
        } else {
            throw '找不到 git.exe。请先按 scripts\README.md 准备便携 git（E:\DeepSeek Study\.tools\git\），或把 git 加入 PATH。'
        }
    } else {
        $script:GitFound = $true
        Write-Ok "git.exe: $($script:GitExe)"
        $gitVersion = Invoke-Git -Arguments @('--version')
        if ($gitVersion.Code -ne 0) {
            throw "git --version 执行失败（exit $($gitVersion.Code)），git 不可用。"
        }
    }

    # ---- 2. 校验 token 并确定 owner ----
    $login = ''
    $ownerIsTokenUser = $false
    if (-not $DryRun) {
        Write-Step '校验 GitHub token'
        $me = Invoke-GitHubApi -Method 'GET' -Path '/user' -Body $null
        if (-not $me.Ok) {
            if ($me.Status -eq 401) {
                throw 'token 无效或已过期（HTTP 401）。请重新生成 PAT 后重试。'
            }
            throw "GET /user 失败（HTTP $($me.Status)）：$($me.Message)"
        }
        $login = [string]$me.Data.login
        Write-Ok "已认证账号: $login"
    }
    if (-not [string]::IsNullOrWhiteSpace($Owner)) {
        if (-not $DryRun -and $Owner -eq $login) { $ownerIsTokenUser = $true }
    } elseif (-not $DryRun) {
        $Owner = $login
        $ownerIsTokenUser = $true
    } else {
        $Owner = '<当前token所属账号>'
    }
    $script:RepoUrl = "https://github.com/$Owner/$Repo"
    Write-Note "仓库地址 : $($script:RepoUrl)"

    # ---- 3. 本地仓库：init / 身份 / add / commit ----
    Write-Step '准备本地 git 仓库'
    $gitDir = Join-Path $script:RepoRoot '.git'
    if (Test-Path -LiteralPath $gitDir) {
        Write-Note '.git 已存在，跳过 git init。'
    } else {
        $initPlan = "[DryRun] git -C `"$($script:RepoRoot)`" init -b main"
        if ($DryRun) {
            Write-Note $initPlan
        } else {
            $initResult = Invoke-Git -Arguments @('-C', $script:RepoRoot, 'init', '-b', 'main') -AllowFailure
            if ($initResult.Code -ne 0) {
                Write-WarnLine 'git init -b main 失败（旧版 git 可能不支持 -b），改为 git init 后重建分支。'
                Invoke-Git -Arguments @('-C', $script:RepoRoot, 'init') | Out-Null
            }
        }
    }

    $identityName = $Owner
    if ([string]::IsNullOrWhiteSpace($identityName)) { $identityName = 'dsh-ncm2mp3' }
    $identityEmail = "$Owner@users.noreply.github.com"
    if ($DryRun -and $Owner -eq '<当前token所属账号>') {
        $identityEmail = '<当前token所属账号>@users.noreply.github.com'
    }

    $currentName = ''
    if (-not $DryRun) {
        $currentName = (Invoke-Git -Arguments @('-C', $script:RepoRoot, 'config', '--local', 'user.name') -AllowFailure -Quiet).Output.Trim()
    }
    if ([string]::IsNullOrWhiteSpace($currentName)) {
        $null = Invoke-GitPlanned -Arguments @('-C', $script:RepoRoot, 'config', '--local', 'user.name', $identityName)
    } else {
        Write-Note "user.name 已配置：$currentName（保持不变）"
    }

    $currentEmail = ''
    if (-not $DryRun) {
        $currentEmail = (Invoke-Git -Arguments @('-C', $script:RepoRoot, 'config', '--local', 'user.email') -AllowFailure -Quiet).Output.Trim()
    }
    if ([string]::IsNullOrWhiteSpace($currentEmail)) {
        $null = Invoke-GitPlanned -Arguments @('-C', $script:RepoRoot, 'config', '--local', 'user.email', $identityEmail)
    } else {
        Write-Note "user.email 已配置：$currentEmail（保持不变）"
    }

    $null = Invoke-GitPlanned -Arguments @('-C', $script:RepoRoot, 'add', '-A')

    $headExists = $false
    if (-not $DryRun) {
        $headCheck = Invoke-Git -Arguments @('-C', $script:RepoRoot, 'rev-parse', '--verify', 'HEAD') -AllowFailure -Quiet
        if ($headCheck.Code -eq 0) { $headExists = $true }
    }
    $commitMessage = "Release v$($script:Version)"
    $doCommit = $false
    if (-not $headExists) {
        $doCommit = $true
    } else {
        $diffCheck = Invoke-Git -Arguments @('-C', $script:RepoRoot, 'diff', '--cached', '--quiet') -AllowFailure
        if ($diffCheck.Code -ne 0) { $doCommit = $true }
    }
    if ($doCommit) {
        $null = Invoke-GitPlanned -Arguments @('-C', $script:RepoRoot, 'commit', '-m', $commitMessage)
        if (-not $DryRun) { Write-Ok "已提交：$commitMessage" }
    } else {
        Write-Note '没有待提交的变更，跳过 commit。'
    }

    $currentBranch = ''
    if (-not $DryRun) {
        $currentBranch = (Invoke-Git -Arguments @('-C', $script:RepoRoot, 'symbolic-ref', '--short', 'HEAD') -AllowFailure -Quiet).Output.Trim()
    }
    if ($DryRun) {
        Write-Note "[DryRun] 若当前分支不是 main：git -C `"$($script:RepoRoot)`" branch -M main"
    } elseif ($currentBranch -ne 'main') {
        $null = Invoke-Git -Arguments @('-C', $script:RepoRoot, 'branch', '-M', 'main')
        Write-Ok '本地分支已命名为 main。'
    }

    # ---- 4. 远端仓库：存在则跳过，不存在则创建 ----
    Write-Step '确认 GitHub 远端仓库'
    $repoApiPath = "/repos/$Owner/$Repo"
    if ($DryRun) {
        Write-Note "[DryRun] GET  $($ApiBase)$repoApiPath"
        $privateJson = 'false'
        if ($isPrivate) { $privateJson = 'true' }
        Write-Note "[DryRun] 若 404 则 POST $($ApiBase)/user/repos"
        Write-Note "[DryRun]        body = {`"name`":`"$Repo`",`"description`":`"<package.json description>`",`"private`":$privateJson,`"auto_init`":false}"
        Write-Note '[DryRun] 若 200 则跳过创建。'
    } else {
        $repoCheck = Invoke-GitHubApi -Method 'GET' -Path $repoApiPath -Body $null
        if ($repoCheck.Ok) {
            Write-Ok "远端仓库已存在：$([string]$repoCheck.Data.html_url)"
        } elseif ($repoCheck.Status -eq 404) {
            if (-not $ownerIsTokenUser) {
                throw "仓库 https://github.com/$Owner/$Repo 不存在，且 -Owner '$Owner' 不是当前 token 账号 '$login'。本脚本只支持在 token 所属账号下自动创建仓库；请在 GitHub 网页手动创建该仓库后重试，或去掉 -Owner 参数。"
            }
            Write-Note "远端仓库不存在，正在创建 $Owner/$Repo ..."
            $createBody = @{
                name        = $Repo
                description = $pkgDescription
                private     = $isPrivate
                auto_init   = $false
            }
            $createResult = Invoke-GitHubApi -Method 'POST' -Path '/user/repos' -Body $createBody
            if (-not $createResult.Ok) {
                if ($createResult.Status -eq 401) {
                    throw '创建仓库失败（HTTP 401）：token 无效或已过期。'
                }
                if ($createResult.Status -eq 403) {
                    throw '创建仓库失败（HTTP 403）：token 权限不足。classic PAT 需要 repo scope；fine-grained token 通常无法创建仓库，请改用 classic token 或在网页手动建仓。'
                }
                throw "创建仓库失败（HTTP $($createResult.Status)）：$($createResult.Message)"
            }
            Write-Ok "远端仓库已创建：$([string]$createResult.Data.html_url)"
        } else {
            throw "查询远端仓库失败（HTTP $($repoCheck.Status)）：$($repoCheck.Message)"
        }
    }

    # ---- 5. 配置 remote（始终保存为不带 token 的 https 地址） ----
    Write-Step '配置 remote origin'
    $existingRemotes = ''
    if (-not $DryRun) {
        $existingRemotes = (Invoke-Git -Arguments @('-C', $script:RepoRoot, 'remote') -AllowFailure -Quiet).Output
    }
    $remoteNames = @()
    if (-not [string]::IsNullOrWhiteSpace($existingRemotes)) {
        $remoteNames = @($existingRemotes -split "`r?`n" | Where-Object { $_ -ne '' })
    }
    if ($remoteNames -contains 'origin') {
        $null = Invoke-GitPlanned -Arguments @('-C', $script:RepoRoot, 'remote', 'set-url', 'origin', $script:RepoUrl) -Display "git -C `"$($script:RepoRoot)`" remote set-url origin $($script:RepoUrl)"
    } else {
        $null = Invoke-GitPlanned -Arguments @('-C', $script:RepoRoot, 'remote', 'add', 'origin', $script:RepoUrl) -Display "git -C `"$($script:RepoRoot)`" remote add origin $($script:RepoUrl)"
    }

    # ---- 6. push（凭据走 http.extraHeader，不写盘、不进 URL） ----
    Write-Step '推送到 GitHub'
    $basicAuth = ''
    if (-not [string]::IsNullOrWhiteSpace($Token)) {
        $authUser = 'x-access-token'
        if (-not [string]::IsNullOrWhiteSpace($login)) { $authUser = $login }
        $basicAuth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$($authUser):$Token"))
    }
    $script:BasicAuth = $basicAuth
    if ($DryRun) {
        Write-Note "[DryRun] git -C `"$($script:RepoRoot)`" -c credential.helper= -c `"http.extraHeader=Authorization: Basic <BASIC-AUTH>`" push -u origin main"
        Write-Note '[DryRun] 真实运行时 token 只在内存和进程参数中出现，不写入 .git/config 或任何文件。'
    } else {
        $pushArgs = @(
            '-C', $script:RepoRoot,
            '-c', 'credential.helper=',
            '-c', "http.extraHeader=Authorization: Basic $basicAuth",
            'push', '-u', 'origin', 'main'
        )
        $oldEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $pushRaw = & $script:GitExe @pushArgs 2>&1
            $pushCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $oldEap
        }
        $pushText = Convert-RawGitOutput $pushRaw
        $pushText = Hide-Secret $pushText
        if ($pushText -ne '') { Write-Note $pushText }
        if ($pushCode -ne 0) {
            throw "git push 失败（exit code $pushCode）。请对照 scripts/README.md 中 401/403/404 与 non-fast-forward 的排查说明。"
        }
        Write-Ok '推送成功。'
    }

    Write-Host ''
    Write-Host '完成！仓库网页地址：' -ForegroundColor Green
    Write-Host "  $($script:RepoUrl)" -ForegroundColor Green
    if (-not $DryRun) {
        Write-Host "  本地包根目录：$($script:RepoRoot)" -ForegroundColor Green
    }
} catch {
    $errorText = $_.Exception.Message
    $errorText = Hide-Secret $errorText
    Write-Host ''
    Write-Host "[失败] $errorText" -ForegroundColor Red
    Write-Host '排查提示：' -ForegroundColor Yellow
    Write-Host '  - 401：token 无效/已过期，或 Authorization 头被代理改写；重新生成 PAT。'
    Write-Host '  - 403：token 权限不足（classic 需 repo scope；fine-grained 需 Contents: Read and write + Metadata: Read），或组织限制/SSO 未授权。'
    Write-Host '  - 404：仓库不存在且无权创建；检查 -Owner/-Repo 拼写，或先在 GitHub 网页建仓。'
    Write-Host '  - non-fast-forward / rejected：远端已有内容且与本地历史无关；改用空仓库（创建时不要 auto_init）或先 git pull --rebase。'
    Write-Host '  - 网络：确认能访问 github.com；代理环境可设置环境变量 HTTPS_PROXY/HTTP_PROXY。'
    $script:ExitCode = 1
} finally {
    # 清理：保证 remote origin 始终为不带 token 的 https 地址
    if (-not $DryRun -and $script:GitFound -and $script:RepoUrl -ne '') {
        try {
            $hasGitDir = Test-Path -LiteralPath (Join-Path $script:RepoRoot '.git')
            if ($hasGitDir) {
                $oldEap = $ErrorActionPreference
                $ErrorActionPreference = 'Continue'
                try {
                    & $script:GitExe -C $script:RepoRoot remote set-url origin $script:RepoUrl 2>&1 | Out-Null
                } finally {
                    $ErrorActionPreference = $oldEap
                }
            }
        } catch {
            # 清理失败不影响主流程结论
        }
    }
}

exit $script:ExitCode
