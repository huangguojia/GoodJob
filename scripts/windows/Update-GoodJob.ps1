param(
    [string]$PackageRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$DataRoot = "",
    [string]$Mirror = "",
    [switch]$NoRestart,
    [switch]$AllowUnsignedForTesting
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "GoodJob.Runtime.psm1") -Force
$context = New-GoodJobContext -PackageRoot $PackageRoot -DataRoot $DataRoot
$log = Start-GoodJobLog -Context $context -Prefix "update"
$lockStream = $null
$oldAppDirectory = $null
$newAppDirectory = $null
$servicesStopped = $false
$stage = "更新准备"
$backup = $null
$stagingRoot = $null

function Resolve-MirrorLocation {
    param([string]$Base, [string]$Child)
    if ($Base -match '^https?://') { return (New-Object Uri -ArgumentList ([Uri]$Base), $Child).AbsoluteUri }
    return Join-Path ([IO.Path]::GetFullPath($Base)) $Child
}

function Copy-UpdateResource {
    param([string]$Source, [string]$Destination, [int]$PercentStart, [int]$PercentEnd, [string]$Message)
    if ($Source -match '^https?://') {
        Add-Type -AssemblyName System.Net.Http
        $client = New-Object Net.Http.HttpClient
        $client.Timeout = [TimeSpan]::FromMinutes(30)
        try {
            $response = $client.GetAsync($Source, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).Result
            if (-not $response.IsSuccessStatusCode) { throw "HTTP $([int]$response.StatusCode)" }
            $total = $response.Content.Headers.ContentLength
            $downloadStream = $response.Content.ReadAsStreamAsync().Result
            $output = [IO.File]::Open($Destination, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try {
                $buffer = New-Object byte[] (1024 * 1024)
                [long]$received = 0
                $lastPercent = -1
                while ($true) {
                    $read = $downloadStream.Read($buffer, 0, $buffer.Length)
                    if ($read -le 0) { break }
                    $output.Write($buffer, 0, $read)
                    $received += $read
                    $percent = if ($total -and $total -gt 0) { $PercentStart + [Math]::Floor(($received / $total) * ($PercentEnd - $PercentStart)) } else { $PercentStart }
                    if ($percent -ne $lastPercent) {
                        $knownTotal = if ($null -eq $total) { 0 } else { [long]$total }
                        Write-UpdateProgress -Context $context -Stage "downloading" -Message $Message -Percent $percent -Details @{ bytesReceived = $received; bytesTotal = $knownTotal }
                        $lastPercent = $percent
                    }
                }
            } finally { $output.Dispose(); $downloadStream.Dispose() }
        } finally { $client.Dispose() }
    } else {
        if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { throw "镜像源文件不存在：$Source" }
        Copy-Item -LiteralPath $Source -Destination $Destination -Force
    }
}

function Assert-SafeZip {
    param([string]$ZipPath)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            if ([IO.Path]::IsPathRooted($name) -or $name -match '(^|/)\.\.(/|$)') { throw "更新包包含不安全路径：$name" }
        }
    } finally { $archive.Dispose() }
}

function Assert-PackageManifest {
    param([string]$AppDirectory)
    $manifestPath = Join-Path $AppDirectory "PACKAGE-MANIFEST.sha256"
    if (-not (Test-Path -LiteralPath $manifestPath)) { throw "更新包缺少 PACKAGE-MANIFEST.sha256" }
    $expected = @{}
    foreach ($line in Get-Content -LiteralPath $manifestPath -Encoding UTF8) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        if ($line -notmatch '^([a-fA-F0-9]{64})  (.+)$') { throw "包内清单格式错误" }
        $relative = $Matches[2].Replace('/', [IO.Path]::DirectorySeparatorChar)
        if ($relative -match '(^|[\\/])\.\.([\\/]|$)' -or [IO.Path]::IsPathRooted($relative)) { throw "包内清单路径不安全：$relative" }
        if ($expected.ContainsKey($relative)) { throw "包内清单存在重复路径：$relative" }
        $expected[$relative] = $true
        $file = Join-Path $AppDirectory $relative
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "包内文件缺失：$relative" }
        $actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $Matches[1].ToLowerInvariant()) { throw "包内文件哈希不匹配：$relative" }
    }
    $actualFiles = @(Get-ChildItem -LiteralPath $AppDirectory -Recurse -File | Where-Object { $_.FullName -ne $manifestPath })
    if ($actualFiles.Count -ne $expected.Count) { throw "包内实际文件数量与完整性清单不一致" }
    foreach ($file in $actualFiles) {
        $relative = $file.FullName.Substring($AppDirectory.Length).TrimStart('\\', '/')
        if (-not $expected.ContainsKey($relative)) { throw "包内存在未登记文件：$relative" }
    }
}

function New-DatabaseBackup {
    param([hashtable]$Config)
    $stamp = Get-Date -Format "yyyyMMdd-HHmmssfff"
    $sqlPath = Join-Path $context.BackupsRoot "goodjob-$($Config.DB_NAME)-pre-update-$stamp.sql"
    $gzipPath = "$sqlPath.gz"
    $errorPath = "$sqlPath.error.log"
    $arguments = @(
        "--defaults-extra-file=$($context.AppClientFile)", "--single-transaction", "--quick",
        "--skip-lock-tables", "--routines", "--events", "--hex-blob", "--default-character-set=utf8mb4",
        [string]$Config.DB_NAME
    )
    $process = Start-Process -FilePath $context.MariaDumpExe -ArgumentList (Join-NativeArguments -Arguments $arguments) -PassThru -Wait -WindowStyle Hidden -RedirectStandardOutput $sqlPath -RedirectStandardError $errorPath
    if ($process.ExitCode -ne 0) {
        $details = Get-Content -LiteralPath $errorPath -Raw -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $sqlPath -Force -ErrorAction SilentlyContinue
        throw "数据库备份失败（退出码 $($process.ExitCode)）：$details"
    }
    $sqlInfo = Get-Item -LiteralPath $sqlPath
    if ($sqlInfo.Length -lt 1024) { throw "数据库备份文件异常过小，更新已中止" }
    $source = [IO.File]::OpenRead($sqlPath)
    $target = [IO.File]::Create($gzipPath)
    Add-Type -AssemblyName System.IO.Compression
    $gzip = New-Object IO.Compression.GZipStream -ArgumentList $target, ([IO.Compression.CompressionLevel]::Optimal)
    try { $source.CopyTo($gzip) } finally { $gzip.Dispose(); $target.Dispose(); $source.Dispose() }
    Remove-Item -LiteralPath $sqlPath -Force
    Remove-Item -LiteralPath $errorPath -Force -ErrorAction SilentlyContinue
    $info = Get-Item -LiteralPath $gzipPath
    return [ordered]@{ file = $gzipPath; size = $info.Length; sha256 = (Get-FileHash -LiteralPath $gzipPath -Algorithm SHA256).Hash.ToLowerInvariant() }
}

try {
    Initialize-GoodJobDirectories -Context $context
    Initialize-GoodJobConfiguration -Context $context
    $lockPath = Join-Path $context.UpdatesRoot "update.lock"
    try { $lockStream = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch { throw "已有更新任务正在运行" }

    $config = Get-GoodJobConfiguration -Context $context
    $context.ApiPort = [int]$config.API_PORT
    $context.CommunicationPort = [int]$config.COMMUNICATION_PORT
    $context.DatabasePort = [int]$config.DATABASE_PORT
    $oldAppDirectory = Get-ActiveAppDirectory -Context $context
    $currentVersion = Get-AppVersion -AppDirectory $oldAppDirectory
    if ([string]::IsNullOrWhiteSpace($Mirror)) {
        $updateConfig = Get-Content -LiteralPath $context.UpdateConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $Mirror = [string]$updateConfig.mirrorUrl
    }
    if ([string]::IsNullOrWhiteSpace($Mirror)) { throw "镜像源未配置" }
    if ($Mirror -match '^https?://') {
        $mirrorUri = [Uri]$Mirror
        if ($mirrorUri.UserInfo -or $mirrorUri.Fragment -or $mirrorUri.Query) { throw "镜像源 URL 不能包含账号、查询参数或片段" }
        if ($mirrorUri.Scheme -eq "http" -and -not @("127.0.0.1", "localhost").Contains($mirrorUri.Host)) { throw "公网镜像源必须使用 HTTPS" }
        if (-not $Mirror.EndsWith('/')) { $Mirror += '/' }
    } elseif (-not (Test-Path -LiteralPath $Mirror -PathType Container)) { throw "本地镜像源目录不存在：$Mirror" }

    $stage = "读取并验证更新清单"
    Write-UpdateProgress -Context $context -Stage "checking" -Message "读取并验证更新清单" -Percent 3
    $manifestPath = Join-Path $context.UpdatesRoot "manifest.json"
    $signaturePath = Join-Path $context.UpdatesRoot "manifest.sig"
    Copy-UpdateResource -Source (Resolve-MirrorLocation -Base $Mirror -Child "manifest.json") -Destination $manifestPath -PercentStart 3 -PercentEnd 5 -Message "下载更新清单"
    Copy-UpdateResource -Source (Resolve-MirrorLocation -Base $Mirror -Child "manifest.sig") -Destination $signaturePath -PercentStart 5 -PercentEnd 6 -Message "下载清单签名"
    $publicKey = Join-Path $context.RuntimeRoot "update-public-key.pem"
    if (-not $AllowUnsignedForTesting) {
        if (-not (Test-Path -LiteralPath $publicKey)) { throw "安装包缺少更新签名公钥" }
        Invoke-ExternalProcess -FilePath $context.NodeExe -Arguments @((Join-Path $context.RuntimeRoot "verify-update-manifest.mjs"), $manifestPath, $signaturePath, $publicKey) -LogPath $log | Out-Null
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([int]$manifest.packageFormatVersion -ne 2) { throw "不支持的更新包格式" }
    $targetVersion = [string]$manifest.latestVersion
    if ($targetVersion -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { throw "更新版本号格式无效" }
    $minimumVersion = [string](Get-StateValue -State $manifest -Name "minimumVersion")
    if ($minimumVersion -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { throw "更新清单最低兼容版本无效" }
    if ((Compare-GoodJobVersion -Left $targetVersion -Right $currentVersion) -le 0) { throw "当前已是 v$currentVersion，没有可应用的新版本" }
    if ((Compare-GoodJobVersion -Left $currentVersion -Right $minimumVersion) -lt 0) { throw "当前版本 v$currentVersion 低于热更新最低版本 v$minimumVersion，请下载完整便携包升级" }
    $release = $manifest.releases.$targetVersion
    if (-not $release -or -not $release.windows) { throw "版本 $targetVersion 没有 Windows x64 更新包" }
    if ([string]$release.databaseCompatibility -ne "backward-compatible") { throw "该版本没有声明数据库向后兼容，不能热更新" }
    $asset = $release.windows
    if ([long]$asset.size -lt 1024 -or [long]$asset.size -gt 1610612736) { throw "更新包大小不在安全范围内" }
    if ([string]$asset.sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw "更新包 SHA256 无效" }
    $assetUrl = [string]$asset.url
    if ([string]::IsNullOrWhiteSpace($assetUrl)) { throw "更新包地址为空" }
    if ($assetUrl -match '^https?://') {
        $assetUri = [Uri]$assetUrl
        if ($assetUri.UserInfo -or $assetUri.Fragment) { throw "更新包地址不能包含账号或片段" }
        if ($assetUri.Scheme -eq "http" -and -not @("127.0.0.1", "localhost").Contains($assetUri.Host)) { throw "公网更新包必须使用 HTTPS" }
    } elseif ([IO.Path]::IsPathRooted($assetUrl) -or $assetUrl.Replace('\\', '/') -match '(^|/)\.\.(/|$)') {
        throw "更新包相对路径不安全"
    }

    $stage = "更新前数据库备份"
    Write-UpdateProgress -Context $context -Stage "backing_up" -Message "更新前强制备份数据库" -Percent 8
    $state = Read-GoodJobState -Context $context
    $databasePid = Get-StateValue -State $state -Name "databasePid"
    $databasePath = [string](Get-StateValue -State $state -Name "databasePath")
    $databaseStartedAt = [string](Get-StateValue -State $state -Name "databaseStartedAt")
    if (-not $state -or -not (Test-OwnedProcess -PidValue $databasePid -ExpectedPath $databasePath -ExpectedStartedAt $databaseStartedAt)) { throw "无法确认 GoodJob 数据库正在运行，请先启动系统再更新" }
    $backup = New-DatabaseBackup -Config $config
    Write-UpdateProgress -Context $context -Stage "backup_verified" -Message "数据库备份完成并通过 SHA256 校验" -Percent 22 -Details @{ backupFile = $backup.file; backupSize = $backup.size; backupSha256 = $backup.sha256 }

    $stage = "下载更新包"
    $assetPath = Join-Path $context.UpdatesRoot "goodjob-app-$targetVersion-win-x64.zip"
    $assetLocation = if ($assetUrl -match '^https?://') { $assetUrl } else { Resolve-MirrorLocation -Base $Mirror -Child $assetUrl }
    Copy-UpdateResource -Source $assetLocation -Destination $assetPath -PercentStart 23 -PercentEnd 58 -Message "下载 Windows 完整更新包"
    $assetInfo = Get-Item -LiteralPath $assetPath
    if ($assetInfo.Length -ne [long]$asset.size) { throw "更新包大小不匹配" }
    $assetHash = (Get-FileHash -LiteralPath $assetPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($assetHash -ne ([string]$asset.sha256).ToLowerInvariant()) { throw "更新包 SHA256 校验失败" }
    Write-UpdateProgress -Context $context -Stage "verifying" -Message "更新包下载和哈希校验完成" -Percent 62

    $stage = "解压并核验发布内容"
    Assert-SafeZip -ZipPath $assetPath
    $stagingRoot = Join-Path $context.UpdatesRoot "staging-$targetVersion-$([Guid]::NewGuid().ToString('N'))"
    Expand-Archive -LiteralPath $assetPath -DestinationPath $stagingRoot -Force
    $candidate = if (Test-Path -LiteralPath (Join-Path $stagingRoot "app")) { Join-Path $stagingRoot "app" } else { $stagingRoot }
    Assert-PackageManifest -AppDirectory $candidate
    foreach ($required in @("backend\dist\server.js", "backend\dist\migrate-mysql.js", "frontend\dist\index.html", "communication\dist\index.html", "communication\dist-server\server\index.js", "communication\dist-server\server\scripts\migrate.js")) {
        if (-not (Test-Path -LiteralPath (Join-Path $candidate $required))) { throw "更新包缺少运行文件：$required" }
    }
    $newAppDirectory = Join-Path $context.ReleasesRoot $targetVersion
    if (Test-Path -LiteralPath $newAppDirectory) { Remove-Item -LiteralPath $newAppDirectory -Recurse -Force }
    Move-Item -LiteralPath $candidate -Destination $newAppDirectory
    Write-UpdateProgress -Context $context -Stage "staged" -Message "新版本已安全解压并逐文件校验" -Percent 70

    $stage = "停止应用服务"
    Invoke-ExternalProcess -FilePath "powershell.exe" -Arguments @(
        "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
        (Join-Path $context.RuntimeRoot "Stop-GoodJob.ps1"), "-PackageRoot", $context.PackageRoot,
        "-DataRoot", $context.DataRoot, "-KeepDatabase"
    ) -LogPath $log | Out-Null
    $servicesStopped = $true
    Write-UpdateProgress -Context $context -Stage "migrating" -Message "应用服务已停止，正在执行幂等迁移" -Percent 76

    Set-GoodJobRuntimeEnvironment -Context $context -AppDirectory $newAppDirectory | Out-Null
    Invoke-ExternalProcess -FilePath $context.NodeExe -Arguments @((Join-Path $newAppDirectory "backend\dist\migrate-mysql.js")) -WorkingDirectory (Join-Path $newAppDirectory "backend") -LogPath $log | Out-Null
    [Environment]::SetEnvironmentVariable("DATABASE_CLIENT", "mysql", "Process")
    [Environment]::SetEnvironmentVariable("AUTO_MIGRATE", "false", "Process")
    [Environment]::SetEnvironmentVariable("SESSION_MASTER_KEY", [string]$config.SESSION_MASTER_KEY, "Process")
    Invoke-ExternalProcess -FilePath $context.NodeExe -Arguments @((Join-Path $newAppDirectory "communication\dist-server\server\scripts\migrate.js")) -WorkingDirectory (Join-Path $newAppDirectory "communication") -LogPath $log | Out-Null

    $stage = "切换并启动新版本"
    Write-JsonAtomic -Path $context.ActiveReleaseFile -Value ([ordered]@{ version = $targetVersion; appDir = $newAppDirectory; previousVersion = $currentVersion; previousAppDir = $oldAppDirectory; activatedAt = [DateTime]::UtcNow.ToString("o"); databaseBackup = $backup })
    Write-UpdateProgress -Context $context -Stage "switching" -Message "迁移通过，切换到新版本" -Percent 86
    if (-not $NoRestart) {
        Invoke-ExternalProcess -FilePath "powershell.exe" -Arguments @(
            "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
            (Join-Path $context.RuntimeRoot "Start-GoodJob.ps1"), "-PackageRoot", $context.PackageRoot,
            "-DataRoot", $context.DataRoot, "-NoBrowser"
        ) -LogPath $log | Out-Null
        if (-not (Wait-HttpReady -Url "http://127.0.0.1:$($context.ApiPort)/api/health" -TimeoutSeconds 90)) { throw "新版本健康检查未通过" }
    }
    $servicesStopped = $false
    Write-UpdateProgress -Context $context -Stage "done" -Message "已更新到 v$targetVersion，数据库备份可用于恢复" -Percent 100 -Details @{ version = $targetVersion; backupFile = $backup.file; backupSha256 = $backup.sha256 }
    Remove-Item -LiteralPath $assetPath, $manifestPath, $signaturePath -Force -ErrorAction SilentlyContinue
} catch {
    $failureRecord = $_
    $failureMessage = $failureRecord.Exception.Message
    Write-GoodJobFailure -ErrorRecord $failureRecord -Stage $stage
    $backupFile = if ($backup) { $backup.file } else { "" }
    $backupSize = if ($backup) { $backup.size } else { 0 }
    $backupSha256 = if ($backup) { $backup.sha256 } else { "" }
    $rollbackFailure = ""
    if ($servicesStopped -and $oldAppDirectory) {
        try {
            Write-UpdateProgress -Context $context -Stage "rolling_back" -Message "正在切回旧版本代码" -Percent 90
            Write-JsonAtomic -Path $context.ActiveReleaseFile -Value ([ordered]@{ version = Get-AppVersion -AppDirectory $oldAppDirectory; appDir = $oldAppDirectory; rolledBackAt = [DateTime]::UtcNow.ToString("o") })
            if (-not $NoRestart) {
                Invoke-ExternalProcess -FilePath "powershell.exe" -Arguments @(
                    "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                    (Join-Path $context.RuntimeRoot "Start-GoodJob.ps1"), "-PackageRoot", $context.PackageRoot,
                    "-DataRoot", $context.DataRoot, "-NoBrowser"
                ) -LogPath $log | Out-Null
            }
        } catch {
            $rollbackFailure = $_.Exception.Message
            Write-GoodJobFailure -ErrorRecord $_ -Stage "自动回滚"
        }
    }
    $finalMessage = if ($rollbackFailure) { "更新失败，且旧版本自动重启失败：$failureMessage；回滚错误：$rollbackFailure" } elseif ($servicesStopped) { "更新失败，已切回旧版本代码：$failureMessage" } else { "更新失败，现有版本未切换：$failureMessage" }
    Write-UpdateProgress -Context $context -Stage "error" -Message $finalMessage -Percent 0 -Details @{ failedStage = $stage; backupFile = $backupFile; backupSize = $backupSize; backupSha256 = $backupSha256 }
    exit 1
} finally {
    if ($stagingRoot -and (Test-Path -LiteralPath $stagingRoot)) { Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue }
    if ($lockStream) { $lockStream.Dispose() }
}
