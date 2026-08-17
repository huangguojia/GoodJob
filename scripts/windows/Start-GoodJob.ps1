param(
    [string]$PackageRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$DataRoot = "",
    [switch]$NoBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "GoodJob.Runtime.psm1") -Force
$context = New-GoodJobContext -PackageRoot $PackageRoot -DataRoot $DataRoot
$log = Start-GoodJobLog -Context $context -Prefix "launcher"
$stage = "启动前检查"
$mariaProcess = $null
$communicationProcess = $null
$crmProcess = $null

try {
    Write-GoodJobLog -Message "GoodJob CRM Windows 便携版启动" -Step 1 -Total 12
    if (-not (Test-IsWindowsPlatform)) { throw "一键启动器只支持 Windows 10/11 x64" }
    if (-not [Environment]::Is64BitOperatingSystem) { throw "仅支持 Windows x64 系统" }
    if ([Environment]::OSVersion.Version.Build -lt 17763) { throw "需要 Windows 10 1809 或更高版本" }
    Initialize-GoodJobDirectories -Context $context

    $stage = "包完整性检查"
    Write-GoodJobLog -Message "检查内嵌 Node.js、MariaDB 与应用文件" -Step 2 -Total 12
    @($context.NodeExe, $context.MariaExe, $context.MariaAdminExe, $context.MariaDumpExe) | ForEach-Object {
        if (-not (Test-Path -LiteralPath $_)) { throw "安装包缺少文件：$_" }
    }
    if (-not (Test-Path -LiteralPath $context.MariaServerExe)) {
        $fallback = Join-Path $context.MariaRoot "bin\mysqld.exe"
        if (-not (Test-Path -LiteralPath $fallback)) { throw "安装包缺少 MariaDB 服务端" }
        $context.MariaServerExe = $fallback
    }

    $stage = "配置初始化"
    Write-GoodJobLog -Message "创建独立数据目录并生成随机密钥" -Step 3 -Total 12
    Initialize-GoodJobConfiguration -Context $context
    $config = Get-GoodJobConfiguration -Context $context
    $context.ApiPort = [int]$config.API_PORT
    $context.CommunicationPort = [int]$config.COMMUNICATION_PORT
    $context.DatabasePort = [int]$config.DATABASE_PORT

    $existingState = Read-GoodJobState -Context $context
    $existingCrmPid = Get-StateValue -State $existingState -Name "crmPid"
    $existingNodePath = [string](Get-StateValue -State $existingState -Name "nodePath")
    $existingCrmStartedAt = [string](Get-StateValue -State $existingState -Name "crmStartedAt")
    if ($existingState -and (Test-ProcessAlive -PidValue $existingCrmPid)) {
        if (-not (Test-OwnedProcess -PidValue $existingCrmPid -ExpectedPath $existingNodePath -ExpectedStartedAt $existingCrmStartedAt)) {
            throw "状态文件中的 CRM PID $existingCrmPid 已被其他程序复用。请运行诊断并删除失效状态后重试"
        }
        if (Wait-HttpReady -Url "http://127.0.0.1:$($context.ApiPort)/api/health" -TimeoutSeconds 3) {
            Write-GoodJobLog -Level OK -Message "GoodJob CRM 已经在运行"
            if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$($context.ApiPort)" }
            exit 0
        }
        throw "检测到残留 CRM 进程 PID $existingCrmPid，请先双击停止程序或运行诊断"
    }
    $existingDatabasePid = Get-StateValue -State $existingState -Name "databasePid"
    $existingDatabasePath = [string](Get-StateValue -State $existingState -Name "databasePath")
    $existingDatabaseStartedAt = [string](Get-StateValue -State $existingState -Name "databaseStartedAt")
    $databaseProcessAlive = $existingState -and (Test-ProcessAlive -PidValue $existingDatabasePid)
    $databaseAlreadyRunning = $databaseProcessAlive -and (Test-OwnedProcess -PidValue $existingDatabasePid -ExpectedPath $existingDatabasePath -ExpectedStartedAt $existingDatabaseStartedAt)
    if ($databaseProcessAlive -and -not $databaseAlreadyRunning) {
        throw "状态文件中的 MariaDB PID $existingDatabasePid 已被其他程序复用。为避免连接错误数据库，启动已中止"
    }
    $databasePid = if ($databaseAlreadyRunning) { [int]$existingDatabasePid } else { 0 }

    $stage = "端口检查"
    Write-GoodJobLog -Message "确认三个本地端口不会连接到其他服务" -Step 4 -Total 12
    Assert-GoodJobPorts -Context $context -AllowDatabaseInUse:$databaseAlreadyRunning

    $stage = "MariaDB 初始化"
    Write-GoodJobLog -Message "初始化包内 MariaDB 数据目录" -Step 5 -Total 12
    $databaseInitialized = Test-Path -LiteralPath (Join-Path $context.DatabaseRoot "mysql")
    if (-not $databaseInitialized -and -not $databaseAlreadyRunning) {
        $installCandidates = @($context.MariaInstallExe, (Join-Path $context.MariaRoot "bin\mysql_install_db.exe"))
        $installer = $installCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
        if (-not $installer) { throw "MariaDB 包缺少 mariadb-install-db.exe" }
        Invoke-ExternalProcess -FilePath $installer -Arguments @("--datadir=$($context.DatabaseRoot)", "--password=") -LogPath $log | Out-Null
    }
    $myIni = @"
[client]
port=$($context.DatabasePort)
host=127.0.0.1
protocol=tcp
default-character-set=utf8mb4

[mariadb]
basedir=$($context.MariaRoot.Replace('\','/'))
datadir=$($context.DatabaseRoot.Replace('\','/'))
port=$($context.DatabasePort)
bind-address=127.0.0.1
skip-name-resolve
character-set-server=utf8mb4
collation-server=utf8mb4_unicode_ci
max-connections=60
innodb-buffer-pool-size=256M
log-error=$((Join-Path $context.LogsRoot 'mariadb-error.log').Replace('\','/'))
pid-file=$((Join-Path $context.StateRoot 'mariadb.pid').Replace('\','/'))
"@
    Write-Utf8File -Path $context.DatabaseConfigFile -Content $myIni

    $stage = "MariaDB 启动"
    Write-GoodJobLog -Message "启动仅监听 127.0.0.1 的便携数据库" -Step 6 -Total 12
    if ($databaseAlreadyRunning) {
        Write-GoodJobLog -Message "复用由 GoodJob 启动的 MariaDB（PID $databasePid）"
    } else {
        $mariaProcess = Start-LoggedProcess -FilePath $context.MariaServerExe -Arguments @("--defaults-file=$($context.DatabaseConfigFile)", "--console") -WorkingDirectory $context.MariaRoot -LogBase (Join-Path $context.LogsRoot "mariadb")
        $databasePid = $mariaProcess.Id
    }
    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        try {
            $arguments = @("--protocol=tcp", "--host=127.0.0.1", "--port=$($context.DatabasePort)", "--user=root")
            if ($databaseInitialized -and (Test-Path -LiteralPath $context.RootClientFile)) { $arguments = @("--defaults-extra-file=$($context.RootClientFile)", "--execute=SELECT 1") }
            else { $arguments += "--execute=SELECT 1" }
            Invoke-ExternalProcess -FilePath $context.MariaExe -Arguments $arguments | Out-Null
            $ready = $true
            break
        } catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $ready) { throw "MariaDB 在 30 秒内未就绪，请查看 mariadb-error.log" }

    $stage = "数据库账号初始化"
    Write-GoodJobLog -Message "创建独立数据库与最小权限账号" -Step 7 -Total 12
    if (-not (Test-Path -LiteralPath $context.RootClientFile)) {
        $sql = @"
CREATE DATABASE IF NOT EXISTS ``$($config.DB_NAME)`` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$($config.DB_USER)'@'127.0.0.1' IDENTIFIED BY '$($config.DB_PASSWORD)';
ALTER USER '$($config.DB_USER)'@'127.0.0.1' IDENTIFIED BY '$($config.DB_PASSWORD)';
GRANT ALL PRIVILEGES ON ``$($config.DB_NAME)``.* TO '$($config.DB_USER)'@'127.0.0.1';
ALTER USER 'root'@'localhost' IDENTIFIED BY '$($config.DB_ROOT_PASSWORD)';
FLUSH PRIVILEGES;
"@
        Invoke-ExternalProcess -FilePath $context.MariaExe -Arguments @("--protocol=tcp", "--host=127.0.0.1", "--port=$($context.DatabasePort)", "--user=root") -StandardInput $sql -LogPath $log | Out-Null
        Write-Utf8File -Path $context.RootClientFile -Content "[client]`nhost=127.0.0.1`nport=$($context.DatabasePort)`nprotocol=tcp`nuser=root`npassword=$($config.DB_ROOT_PASSWORD)`n"
        Write-Utf8File -Path $context.AppClientFile -Content "[client]`nhost=127.0.0.1`nport=$($context.DatabasePort)`nprotocol=tcp`nuser=$($config.DB_USER)`npassword=$($config.DB_PASSWORD)`n"
        Protect-GoodJobFile -Path $context.RootClientFile
        Protect-GoodJobFile -Path $context.AppClientFile
    }

    $appDirectory = Get-ActiveAppDirectory -Context $context
    Set-GoodJobRuntimeEnvironment -Context $context -AppDirectory $appDirectory | Out-Null

    $stage = "CRM 数据迁移"
    Write-GoodJobLog -Message "执行幂等数据库迁移" -Step 8 -Total 12
    Invoke-ExternalProcess -FilePath $context.NodeExe -Arguments @((Join-Path $appDirectory "backend\dist\migrate-mysql.js")) -WorkingDirectory (Join-Path $appDirectory "backend") -LogPath $log | Out-Null

    $stage = "Communication 数据迁移"
    Write-GoodJobLog -Message "核验 Communication 表结构" -Step 9 -Total 12
    [Environment]::SetEnvironmentVariable("DATABASE_CLIENT", "mysql", "Process")
    [Environment]::SetEnvironmentVariable("AUTO_MIGRATE", "false", "Process")
    [Environment]::SetEnvironmentVariable("SESSION_MASTER_KEY", [string]$config.SESSION_MASTER_KEY, "Process")
    [Environment]::SetEnvironmentVariable("MEDIA_STORAGE_PATH", $context.CommunicationDataRoot, "Process")
    [Environment]::SetEnvironmentVariable("WEB_ORIGIN", "http://127.0.0.1:$($context.ApiPort)", "Process")
    [Environment]::SetEnvironmentVariable("HOST", "127.0.0.1", "Process")
    [Environment]::SetEnvironmentVariable("PORT", [string]$context.CommunicationPort, "Process")
    Invoke-ExternalProcess -FilePath $context.NodeExe -Arguments @((Join-Path $appDirectory "communication\dist-server\server\scripts\migrate.js")) -WorkingDirectory (Join-Path $appDirectory "communication") -LogPath $log | Out-Null

    $stage = "服务启动"
    Write-GoodJobLog -Message "启动 Communication 与 CRM" -Step 10 -Total 12
    $communicationProcess = Start-LoggedProcess -FilePath $context.NodeExe -Arguments @((Join-Path $appDirectory "communication\dist-server\server\index.js")) -WorkingDirectory (Join-Path $appDirectory "communication") -LogBase (Join-Path $context.LogsRoot "communication")
    [Environment]::SetEnvironmentVariable("PORT", [string]$context.ApiPort, "Process")
    [Environment]::SetEnvironmentVariable("HOST", $null, "Process")
    $crmProcess = Start-LoggedProcess -FilePath $context.NodeExe -Arguments @((Join-Path $appDirectory "backend\dist\server.js")) -WorkingDirectory (Join-Path $appDirectory "backend") -LogBase (Join-Path $context.LogsRoot "backend")
    Write-JsonAtomic -Path $context.StateFile -Value ([ordered]@{
        startedAt = [DateTime]::UtcNow.ToString("o"); appDir = $appDirectory; version = Get-AppVersion -AppDirectory $appDirectory
        crmPid = $crmProcess.Id; communicationPid = $communicationProcess.Id; databasePid = $databasePid
        crmStartedAt = $crmProcess.StartTime.ToUniversalTime().ToString("o")
        communicationStartedAt = $communicationProcess.StartTime.ToUniversalTime().ToString("o")
        databaseStartedAt = if ($mariaProcess) { $mariaProcess.StartTime.ToUniversalTime().ToString("o") } else { $existingDatabaseStartedAt }
        nodePath = $context.NodeExe; databasePath = $context.MariaServerExe
        apiPort = $context.ApiPort; communicationPort = $context.CommunicationPort; databasePort = $context.DatabasePort
    })

    $stage = "健康检查"
    Write-GoodJobLog -Message "等待两个服务通过健康检查" -Step 11 -Total 12
    if (-not (Wait-HttpReady -Url "http://127.0.0.1:$($context.CommunicationPort)/api/health/ready" -TimeoutSeconds 60)) { throw "Communication 健康检查超时" }
    if (-not (Wait-HttpReady -Url "http://127.0.0.1:$($context.ApiPort)/api/health" -TimeoutSeconds 90)) { throw "CRM 健康检查超时" }

    Write-GoodJobLog -Level OK -Message "GoodJob CRM 已启动：http://127.0.0.1:$($context.ApiPort)" -Step 12 -Total 12
    Write-Host "数据目录：$($context.DataRoot)"
    Write-Host "日志目录：$($context.LogsRoot)"
    Write-Host "首次账号：$(Join-Path $context.ConfigRoot '首次登录账号.txt')"
    if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$($context.ApiPort)" }
} catch {
    Write-GoodJobFailure -ErrorRecord $_ -Stage $stage
    $state = Read-GoodJobState -Context $context
    if ($state) {
        $stateNodePath = [string](Get-StateValue -State $state -Name "nodePath")
        Stop-OwnedProcess -PidValue (Get-StateValue -State $state -Name "crmPid") -Name "CRM" -ExpectedPath $stateNodePath -ExpectedStartedAt ([string](Get-StateValue -State $state -Name "crmStartedAt"))
        Stop-OwnedProcess -PidValue (Get-StateValue -State $state -Name "communicationPid") -Name "Communication" -ExpectedPath $stateNodePath -ExpectedStartedAt ([string](Get-StateValue -State $state -Name "communicationStartedAt"))
    }
    if ($crmProcess) { Stop-Process -Id $crmProcess.Id -Force -ErrorAction SilentlyContinue }
    if ($communicationProcess) { Stop-Process -Id $communicationProcess.Id -Force -ErrorAction SilentlyContinue }
    if ($mariaProcess) { Stop-Process -Id $mariaProcess.Id -Force -ErrorAction SilentlyContinue }
    exit 1
}
