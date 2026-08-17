Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:Context = $null
$script:LogFile = $null

function Test-IsWindowsPlatform {
    return [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
}

function New-GoodJobContext {
    param(
        [Parameter(Mandatory = $true)][string]$PackageRoot,
        [string]$DataRoot = ""
    )
    $resolvedPackageRoot = [IO.Path]::GetFullPath($PackageRoot)
    if ([string]::IsNullOrWhiteSpace($DataRoot)) {
        $localData = [Environment]::GetEnvironmentVariable("LOCALAPPDATA")
        if ([string]::IsNullOrWhiteSpace($localData)) { throw "无法确定当前用户的 LOCALAPPDATA 目录" }
        $DataRoot = Join-Path $localData "GoodJobCRM"
    }
    $resolvedDataRoot = [IO.Path]::GetFullPath($DataRoot)
    $context = [ordered]@{
        PackageRoot = $resolvedPackageRoot
        DataRoot = $resolvedDataRoot
        ConfigRoot = Join-Path $resolvedDataRoot "config"
        DatabaseRoot = Join-Path $resolvedDataRoot "data\mysql"
        UploadsRoot = Join-Path $resolvedDataRoot "data\uploads"
        CommunicationDataRoot = Join-Path $resolvedDataRoot "data\communication"
        LogsRoot = Join-Path $resolvedDataRoot "logs"
        BackupsRoot = Join-Path $resolvedDataRoot "backups\database"
        ReleasesRoot = Join-Path $resolvedDataRoot "releases"
        StateRoot = Join-Path $resolvedDataRoot "runtime"
        UpdatesRoot = Join-Path $resolvedDataRoot "updates"
        RuntimeRoot = Join-Path $resolvedPackageRoot "runtime"
        NodeExe = Join-Path $resolvedPackageRoot "runtime\node\node.exe"
        MariaRoot = Join-Path $resolvedPackageRoot "runtime\mariadb"
        MariaExe = Join-Path $resolvedPackageRoot "runtime\mariadb\bin\mariadb.exe"
        MariaAdminExe = Join-Path $resolvedPackageRoot "runtime\mariadb\bin\mariadb-admin.exe"
        MariaDumpExe = Join-Path $resolvedPackageRoot "runtime\mariadb\bin\mariadb-dump.exe"
        MariaServerExe = Join-Path $resolvedPackageRoot "runtime\mariadb\bin\mariadbd.exe"
        MariaInstallExe = Join-Path $resolvedPackageRoot "runtime\mariadb\bin\mariadb-install-db.exe"
        EnvironmentFile = Join-Path $resolvedDataRoot "config\runtime.env"
        SecretsFile = Join-Path $resolvedDataRoot "config\secrets.env"
        RootClientFile = Join-Path $resolvedDataRoot "config\mariadb-root.ini"
        AppClientFile = Join-Path $resolvedDataRoot "config\mariadb-app.ini"
        DatabaseConfigFile = Join-Path $resolvedDataRoot "config\my.ini"
        StateFile = Join-Path $resolvedDataRoot "runtime\state.json"
        ActiveReleaseFile = Join-Path $resolvedDataRoot "runtime\active-release.json"
        UpdateConfigFile = Join-Path $resolvedDataRoot "config\update-config.json"
        UpdateProgressFile = Join-Path $resolvedDataRoot "updates\progress.json"
        ApiPort = 4188
        CommunicationPort = 3100
        DatabasePort = 13306
    }
    $script:Context = $context
    return $context
}

function Initialize-GoodJobDirectories {
    param([Parameter(Mandatory = $true)]$Context)
    @(
        $Context.ConfigRoot, $Context.DatabaseRoot, $Context.UploadsRoot,
        $Context.CommunicationDataRoot, $Context.LogsRoot, $Context.BackupsRoot,
        $Context.ReleasesRoot, $Context.StateRoot, $Context.UpdatesRoot
    ) | ForEach-Object { [IO.Directory]::CreateDirectory($_) | Out-Null }
}

function Start-GoodJobLog {
    param([Parameter(Mandatory = $true)]$Context, [string]$Prefix = "launcher")
    Initialize-GoodJobDirectories -Context $Context
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $script:LogFile = Join-Path $Context.LogsRoot "$Prefix-$stamp.log"
    New-Item -ItemType File -Path $script:LogFile -Force | Out-Null
    return $script:LogFile
}

function Write-GoodJobLog {
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [ValidateSet("INFO", "OK", "WARN", "ERROR")][string]$Level = "INFO",
        [int]$Step = 0,
        [int]$Total = 0
    )
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"
    $progress = if ($Step -gt 0 -and $Total -gt 0) { " [$Step/$Total]" } else { "" }
    $line = "[$timestamp] [$Level]$progress $Message"
    $color = "Cyan"
    switch ($Level) {
        "OK" { $color = "Green"; break }
        "WARN" { $color = "Yellow"; break }
        "ERROR" { $color = "Red"; break }
    }
    Write-Host $line -ForegroundColor $color
    if ($script:LogFile) { Add-Content -LiteralPath $script:LogFile -Value $line -Encoding UTF8 }
}

function Write-GoodJobFailure {
    param([Parameter(Mandatory = $true)]$ErrorRecord, [string]$Stage = "未分类")
    $message = if ($ErrorRecord.Exception) { $ErrorRecord.Exception.Message } else { [string]$ErrorRecord }
    Write-GoodJobLog -Level ERROR -Message "$Stage：$message"
    if ($script:LogFile) {
        Add-Content -LiteralPath $script:LogFile -Value ($ErrorRecord | Out-String) -Encoding UTF8
        Write-Host "详细日志：$script:LogFile" -ForegroundColor Yellow
    }
}

function New-SecureToken {
    param([ValidateRange(16, 128)][int]$Bytes = 32, [switch]$Hex)
    $buffer = New-Object byte[] $Bytes
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($buffer) } finally { $generator.Dispose() }
    if ($Hex) { return ([BitConverter]::ToString($buffer).Replace("-", "")).ToLowerInvariant() }
    return [Convert]::ToBase64String($buffer)
}

function New-SafePassword {
    param([ValidateRange(16, 64)][int]$Length = 28)
    $alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
    $buffer = New-Object byte[] $Length
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($buffer) } finally { $generator.Dispose() }
    return -join ($buffer | ForEach-Object { $alphabet[$_ % $alphabet.Length] })
}

function Protect-GoodJobFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    if (Test-IsWindowsPlatform) {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        & icacls.exe $Path /inheritance:r /grant:r "${identity}:(F)" "SYSTEM:(F)" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "无法限制敏感配置文件权限：$Path" }
    }
}

function Write-Utf8File {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Content)
    [IO.File]::WriteAllText($Path, $Content, (New-Object Text.UTF8Encoding -ArgumentList $false))
}

function Read-DotEnvFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    $values = @{}
    if (-not (Test-Path -LiteralPath $Path)) { return $values }
    foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
        if ([string]::IsNullOrWhiteSpace($line) -or $line.TrimStart().StartsWith("#")) { continue }
        $index = $line.IndexOf("=")
        if ($index -lt 1) { continue }
        $values[$line.Substring(0, $index).Trim()] = $line.Substring($index + 1)
    }
    return $values
}

function Set-ProcessEnvironment {
    param([hashtable]$Values)
    foreach ($entry in $Values.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable([string]$entry.Key, [string]$entry.Value, "Process")
    }
}

function Initialize-GoodJobConfiguration {
    param([Parameter(Mandatory = $true)]$Context)
    if (-not (Test-Path -LiteralPath $Context.SecretsFile)) {
        $dbPassword = New-SafePassword
        $rootPassword = New-SafePassword
        $adminPassword = New-SafePassword -Length 20
        $content = @(
            "DB_PASSWORD=$dbPassword"
            "DB_ROOT_PASSWORD=$rootPassword"
            "JWT_SECRET=$(New-SecureToken -Bytes 48)"
            "SESSION_MASTER_KEY=$(New-SecureToken -Bytes 32)"
            "PROVIDER_CREDENTIAL_KEY=$(New-SecureToken -Bytes 32)"
            "MYSQL_DATA_IMPORT_TOKEN=$(New-SecureToken -Bytes 32 -Hex)"
            "AGENT_JOB_ENCRYPTION_KEY=$(New-SecureToken -Bytes 32)"
            "TRADE_OBSERVATION_CURSOR_SECRET=$(New-SecureToken -Bytes 32)"
            "MARKET_OPPORTUNITY_CURSOR_SECRET=$(New-SecureToken -Bytes 32)"
            "PROSPECT_RUN_IDEMPOTENCY_SECRET=$(New-SecureToken -Bytes 32)"
            "PROSPECT_RUN_CURSOR_SECRET=$(New-SecureToken -Bytes 32)"
            "PROSPECT_EXECUTION_CLAIM_SECRET=$(New-SecureToken -Bytes 32)"
            "ORGANIZATION_IDENTITY_MASTER_SECRET=$(New-SecureToken -Bytes 32)"
            "PROSPECT_SOURCE_RAW_ENVELOPE_SECRET=$(New-SecureToken -Bytes 32)"
            "PROSPECT_COVERAGE_MASTER_SECRET=$(New-SecureToken -Bytes 32)"
            "INITIAL_ADMIN_EMAIL=admin@goodjob.local"
            "INITIAL_ADMIN_PASSWORD=$adminPassword"
            "INITIAL_ADMIN_NAME=GoodJob Admin"
        ) -join "`n"
        Write-Utf8File -Path $Context.SecretsFile -Content ($content + "`n")
        Protect-GoodJobFile -Path $Context.SecretsFile
        $credentialFile = Join-Path $Context.ConfigRoot "首次登录账号.txt"
        Write-Utf8File -Path $credentialFile -Content "GoodJob CRM 首次登录账号`r`n账号：admin@goodjob.local`r`n密码：$adminPassword`r`n`r`n登录后请立即修改密码。`r`n"
        Protect-GoodJobFile -Path $credentialFile
    }
    if (-not (Test-Path -LiteralPath $Context.EnvironmentFile)) {
        $content = @(
            "API_PORT=$($Context.ApiPort)"
            "COMMUNICATION_PORT=$($Context.CommunicationPort)"
            "DATABASE_PORT=$($Context.DatabasePort)"
            "DB_NAME=goodjob_crm"
            "DB_USER=goodjob_app"
        ) -join "`n"
        Write-Utf8File -Path $Context.EnvironmentFile -Content ($content + "`n")
    }
    if (-not (Test-Path -LiteralPath $Context.UpdateConfigFile)) {
        Write-JsonAtomic -Path $Context.UpdateConfigFile -Value ([ordered]@{ mirrorUrl = ""; channel = "stable" })
    }
}

function Convert-GoodJobVersion {
    param([string]$Value)
    $match = [regex]::Match($Value, '^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$')
    if (-not $match.Success) { throw "版本号格式无效：$Value" }
    return [ordered]@{
        core = @([long]$match.Groups[1].Value, [long]$match.Groups[2].Value, [long]$match.Groups[3].Value)
        prerelease = [string]$match.Groups[4].Value
    }
}

function Compare-GoodJobVersion {
    param([string]$Left, [string]$Right)
    $leftVersion = Convert-GoodJobVersion -Value $Left
    $rightVersion = Convert-GoodJobVersion -Value $Right
    for ($index = 0; $index -lt 3; $index++) {
        if ($leftVersion.core[$index] -gt $rightVersion.core[$index]) { return 1 }
        if ($leftVersion.core[$index] -lt $rightVersion.core[$index]) { return -1 }
    }
    if (-not $leftVersion.prerelease -and -not $rightVersion.prerelease) { return 0 }
    if (-not $leftVersion.prerelease) { return 1 }
    if (-not $rightVersion.prerelease) { return -1 }
    $leftIdentifiers = @($leftVersion.prerelease -split '\.')
    $rightIdentifiers = @($rightVersion.prerelease -split '\.')
    $limit = [Math]::Max($leftIdentifiers.Count, $rightIdentifiers.Count)
    for ($index = 0; $index -lt $limit; $index++) {
        if ($index -ge $leftIdentifiers.Count) { return -1 }
        if ($index -ge $rightIdentifiers.Count) { return 1 }
        [long]$leftNumber = 0
        [long]$rightNumber = 0
        $leftNumeric = [long]::TryParse($leftIdentifiers[$index], [ref]$leftNumber)
        $rightNumeric = [long]::TryParse($rightIdentifiers[$index], [ref]$rightNumber)
        if ($leftNumeric -and $rightNumeric) {
            if ($leftNumber -gt $rightNumber) { return 1 }
            if ($leftNumber -lt $rightNumber) { return -1 }
        } elseif ($leftNumeric -ne $rightNumeric) {
            return $(if ($leftNumeric) { -1 } else { 1 })
        } else {
            $comparison = [string]::CompareOrdinal($leftIdentifiers[$index], $rightIdentifiers[$index])
            if ($comparison -ne 0) { return $(if ($comparison -gt 0) { 1 } else { -1 }) }
        }
    }
    return 0
}

function Get-GoodJobConfiguration {
    param([Parameter(Mandatory = $true)]$Context)
    $values = Read-DotEnvFile -Path $Context.EnvironmentFile
    foreach ($entry in (Read-DotEnvFile -Path $Context.SecretsFile).GetEnumerator()) { $values[$entry.Key] = $entry.Value }
    return $values
}

function Get-ActiveAppDirectory {
    param([Parameter(Mandatory = $true)]$Context)
    $bundled = Join-Path $Context.PackageRoot "app"
    if (Test-Path -LiteralPath $Context.ActiveReleaseFile) {
        try {
            $active = Get-Content -LiteralPath $Context.ActiveReleaseFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($active.appDir -and (Test-Path -LiteralPath $active.appDir)) {
                $activeDirectory = [IO.Path]::GetFullPath([string]$active.appDir)
                if (Test-Path -LiteralPath $bundled) {
                    $activeVersion = Get-AppVersion -AppDirectory $activeDirectory
                    $bundledVersion = Get-AppVersion -AppDirectory $bundled
                    if ((Compare-GoodJobVersion -Left $bundledVersion -Right $activeVersion) -gt 0) { return $bundled }
                }
                return $activeDirectory
            }
        } catch { }
    }
    if (-not (Test-Path -LiteralPath $bundled)) { throw "应用目录不存在：$bundled" }
    return $bundled
}

function Get-AppVersion {
    param([Parameter(Mandatory = $true)][string]$AppDirectory)
    $packageFile = Join-Path $AppDirectory "package.json"
    if (-not (Test-Path -LiteralPath $packageFile)) { return "0.0.0" }
    return [string]((Get-Content -LiteralPath $packageFile -Raw -Encoding UTF8 | ConvertFrom-Json).version)
}

function Write-JsonAtomic {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)]$Value)
    [IO.Directory]::CreateDirectory((Split-Path -Parent $Path)) | Out-Null
    $temporary = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
    Write-Utf8File -Path $temporary -Content (($Value | ConvertTo-Json -Depth 12) + "`n")
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Test-PortAvailable {
    param([Parameter(Mandatory = $true)][int]$Port)
    $listener = New-Object Net.Sockets.TcpListener -ArgumentList ([Net.IPAddress]::Loopback), $Port
    try { $listener.Start(); return $true } catch { return $false } finally { try { $listener.Stop() } catch { } }
}

function Assert-GoodJobPorts {
    param([Parameter(Mandatory = $true)]$Context, [switch]$AllowDatabaseInUse)
    $ports = @(
        @{ Name = "CRM"; Port = [int]$Context.ApiPort; Allow = $false },
        @{ Name = "Communication"; Port = [int]$Context.CommunicationPort; Allow = $false },
        @{ Name = "MariaDB"; Port = [int]$Context.DatabasePort; Allow = [bool]$AllowDatabaseInUse }
    )
    foreach ($item in $ports) {
        if (-not $item.Allow -and -not (Test-PortAvailable -Port $item.Port)) {
            $owner = Get-NetTCPConnection -LocalPort $item.Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
            $suffix = if ($owner) { "，占用 PID $($owner.OwningProcess)" } else { "" }
            throw "$($item.Name) 端口 $($item.Port) 已被占用$suffix。为避免连错数据库或服务，本程序不会自动更换端口。"
        }
    }
}

function Test-ProcessAlive {
    param([object]$PidValue)
    if (-not $PidValue) { return $false }
    return $null -ne (Get-Process -Id ([int]$PidValue) -ErrorAction SilentlyContinue)
}

function Get-StateValue {
    param([object]$State, [string]$Name, [object]$Default = $null)
    if (-not $State) { return $Default }
    $property = $State.PSObject.Properties[$Name]
    if (-not $property -or $null -eq $property.Value) { return $Default }
    return $property.Value
}

function Test-OwnedProcess {
    param(
        [object]$PidValue,
        [string]$ExpectedPath,
        [string]$ExpectedStartedAt
    )
    if (-not (Test-ProcessAlive -PidValue $PidValue)) { return $false }
    if ([string]::IsNullOrWhiteSpace($ExpectedPath) -or [string]::IsNullOrWhiteSpace($ExpectedStartedAt)) { return $false }
    $process = Get-Process -Id ([int]$PidValue) -ErrorAction SilentlyContinue
    if (-not $process) { return $false }
    try {
        $actualPath = [IO.Path]::GetFullPath([string]$process.Path)
        $expectedFullPath = [IO.Path]::GetFullPath($ExpectedPath)
        if (-not $actualPath.Equals($expectedFullPath, [StringComparison]::OrdinalIgnoreCase)) { return $false }
        $expectedStart = [DateTime]::Parse($ExpectedStartedAt).ToUniversalTime()
        return [Math]::Abs(($process.StartTime.ToUniversalTime() - $expectedStart).TotalSeconds) -le 3
    } catch { return $false }
}

function Read-GoodJobState {
    param([Parameter(Mandatory = $true)]$Context)
    if (-not (Test-Path -LiteralPath $Context.StateFile)) { return $null }
    try { return Get-Content -LiteralPath $Context.StateFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
}

function Wait-HttpReady {
    param([Parameter(Mandatory = $true)][string]$Url, [int]$TimeoutSeconds = 60)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) { return $true }
        } catch { }
        Start-Sleep -Milliseconds 750
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

function Invoke-ExternalProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [string]$WorkingDirectory = "",
        [string]$StandardInput = "",
        [string]$LogPath = ""
    )
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $FilePath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.RedirectStandardInput = $true
    if ($WorkingDirectory) { $startInfo.WorkingDirectory = $WorkingDirectory }
    $startInfo.Arguments = Join-NativeArguments -Arguments $Arguments
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    [void]$process.Start()
    if ($StandardInput) { $process.StandardInput.Write($StandardInput) }
    $process.StandardInput.Close()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $output = $stdout.Result
    $errorOutput = $stderr.Result
    if ($LogPath) { Add-Content -LiteralPath $LogPath -Value ($output + $errorOutput) -Encoding UTF8 }
    if ($process.ExitCode -ne 0) { throw "$FilePath 退出码 $($process.ExitCode)：$($errorOutput.Trim())" }
    return $output
}

function Start-LoggedProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$LogBase
    )
    $outLog = "$LogBase.out.log"
    $errorLog = "$LogBase.error.log"
    $process = Start-Process -FilePath $FilePath -ArgumentList (Join-NativeArguments -Arguments $Arguments) -WorkingDirectory $WorkingDirectory -PassThru -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errorLog
    Start-Sleep -Milliseconds 400
    if ($process.HasExited) {
        $details = ((Get-Content -LiteralPath $errorLog -Raw -ErrorAction SilentlyContinue) + (Get-Content -LiteralPath $outLog -Raw -ErrorAction SilentlyContinue)).Trim()
        throw "进程启动后立即退出（$($process.ExitCode)）：$details"
    }
    return $process
}

function ConvertTo-NativeArgument {
    param([AllowEmptyString()][string]$Value)
    if ($Value -notmatch '[\s"]') { return $Value }
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}

function Join-NativeArguments {
    param([string[]]$Arguments = @())
    return (($Arguments | ForEach-Object { ConvertTo-NativeArgument -Value $_ }) -join " ")
}

function Stop-OwnedProcess {
    param(
        [object]$PidValue,
        [string]$Name,
        [string]$ExpectedPath = "",
        [string]$ExpectedStartedAt = "",
        [int]$TimeoutSeconds = 15
    )
    if (-not (Test-ProcessAlive -PidValue $PidValue)) { return }
    $process = Get-Process -Id ([int]$PidValue) -ErrorAction SilentlyContinue
    if (-not $process) { return }
    if (-not (Test-OwnedProcess -PidValue $PidValue -ExpectedPath $ExpectedPath -ExpectedStartedAt $ExpectedStartedAt)) {
        Write-GoodJobLog -Level WARN -Message "拒绝停止 $Name：无法确认 PID $PidValue 属于 GoodJob"
        return
    }
    Write-GoodJobLog -Message "正在停止 $Name（PID $PidValue）"
    try { $process.CloseMainWindow() | Out-Null } catch { }
    try { Stop-Process -Id ([int]$PidValue) -ErrorAction SilentlyContinue } catch { }
    try { Wait-Process -Id ([int]$PidValue) -Timeout $TimeoutSeconds -ErrorAction SilentlyContinue } catch { }
    if (Test-ProcessAlive -PidValue $PidValue) { Stop-Process -Id ([int]$PidValue) -Force -ErrorAction SilentlyContinue }
}

function Set-GoodJobRuntimeEnvironment {
    param([Parameter(Mandatory = $true)]$Context, [Parameter(Mandatory = $true)][string]$AppDirectory)
    $config = Get-GoodJobConfiguration -Context $Context
    $dbPasswordEncoded = [Uri]::EscapeDataString([string]$config.DB_PASSWORD)
    $databaseUrl = "mysql://$($config.DB_USER):$dbPasswordEncoded@127.0.0.1:$($Context.DatabasePort)/$($config.DB_NAME)"
    $values = @{
        CRM_STORE = "mysql"; NODE_ENV = "production"; APP_DATABASE_PROFILE = "production"
        CRM_SEED_DEVELOPMENT_DATA = "false"; PORT = [string]$Context.ApiPort; BACKEND_HOST = "127.0.0.1"
        CORS_ORIGINS = "http://127.0.0.1:$($Context.ApiPort),http://localhost:$($Context.ApiPort)"
        SESSION_COOKIE_SECURE = "false"; ENABLE_API_DOCS = "false"; PROSPECT_WORKER_ENABLED = "false"
        PROSPECT_QUEUE_REQUIRED = "false"; DATABASE_URL = $databaseUrl; MYSQL_URL = $databaseUrl
        FRONTEND_DIST = (Join-Path $AppDirectory "frontend\dist")
        COMMUNICATION_FRONTEND_DIST = (Join-Path $AppDirectory "communication\dist")
        COMMUNICATION_API_ORIGIN = "http://127.0.0.1:$($Context.CommunicationPort)"
        AGENT_SKILLS_DIR = (Join-Path $AppDirectory "agent-skills")
        AGENT_KNOWLEDGE_DIR = (Join-Path $AppDirectory "agent-knowledge")
        GOODJOB_DATA_DIR = $Context.DataRoot; GOODJOB_APP_DIR = $AppDirectory
        GOODJOB_PACKAGE_ROOT = $Context.PackageRoot; GOODJOB_UPLOADS_DIR = $Context.UploadsRoot
        GOODJOB_UPDATER_SCRIPT = (Join-Path $Context.PackageRoot "runtime\Update-GoodJob.ps1")
        GOODJOB_UPDATE_CONFIG_FILE = $Context.UpdateConfigFile
        GOODJOB_UPDATE_PROGRESS_FILE = $Context.UpdateProgressFile
        GOODJOB_UPDATE_PUBLIC_KEY = (Join-Path $Context.PackageRoot "runtime\update-public-key.pem")
        MYSQL_LOCAL_BACKUP_ENABLED = "true"; MYSQL_LOCAL_BACKUP_DIR = $Context.BackupsRoot
        MYSQL_LOCAL_BACKUP_RETENTION_DAYS = "30"; MYSQLDUMP_BIN = $Context.MariaDumpExe
        GOODJOB_MYSQL_CLIENT = $Context.MariaExe
        INITIAL_ADMIN_EMAIL = [string]$config.INITIAL_ADMIN_EMAIL
        INITIAL_ADMIN_PASSWORD = [string]$config.INITIAL_ADMIN_PASSWORD
        INITIAL_ADMIN_NAME = [string]$config.INITIAL_ADMIN_NAME
        JWT_SECRET = [string]$config.JWT_SECRET; CRM_JWT_SECRET = [string]$config.JWT_SECRET
        PROVIDER_CREDENTIAL_KEY = [string]$config.PROVIDER_CREDENTIAL_KEY
        MYSQL_DATA_IMPORT_TOKEN = [string]$config.MYSQL_DATA_IMPORT_TOKEN
        AGENT_JOB_ENCRYPTION_KEY = [string]$config.AGENT_JOB_ENCRYPTION_KEY
        TRADE_OBSERVATION_CURSOR_SECRET = [string]$config.TRADE_OBSERVATION_CURSOR_SECRET
        MARKET_OPPORTUNITY_CURSOR_SECRET = [string]$config.MARKET_OPPORTUNITY_CURSOR_SECRET
        PROSPECT_RUN_IDEMPOTENCY_SECRET = [string]$config.PROSPECT_RUN_IDEMPOTENCY_SECRET
        PROSPECT_RUN_CURSOR_SECRET = [string]$config.PROSPECT_RUN_CURSOR_SECRET
        PROSPECT_EXECUTION_CLAIM_SECRET = [string]$config.PROSPECT_EXECUTION_CLAIM_SECRET
        ORGANIZATION_IDENTITY_MASTER_SECRET = [string]$config.ORGANIZATION_IDENTITY_MASTER_SECRET
        PROSPECT_SOURCE_RAW_ENVELOPE_SECRET = [string]$config.PROSPECT_SOURCE_RAW_ENVELOPE_SECRET
        PROSPECT_COVERAGE_MASTER_SECRET = [string]$config.PROSPECT_COVERAGE_MASTER_SECRET
    }
    Set-ProcessEnvironment -Values $values
    return @{ Config = $config; DatabaseUrl = $databaseUrl }
}

function Write-UpdateProgress {
    param([Parameter(Mandatory = $true)]$Context, [string]$Stage, [string]$Message, [int]$Percent, [hashtable]$Details = @{})
    $payload = [ordered]@{ stage = $Stage; message = $Message; percent = $Percent; updatedAt = [DateTime]::UtcNow.ToString("o") }
    foreach ($entry in $Details.GetEnumerator()) { $payload[$entry.Key] = $entry.Value }
    Write-JsonAtomic -Path $Context.UpdateProgressFile -Value $payload
    Write-GoodJobLog -Message "$Message（$Percent%）"
}

Export-ModuleMember -Function *
