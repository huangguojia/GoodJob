param(
    [string]$PackageRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$DataRoot = "",
    [switch]$KeepDatabase
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "GoodJob.Runtime.psm1") -Force
$context = New-GoodJobContext -PackageRoot $PackageRoot -DataRoot $DataRoot
Start-GoodJobLog -Context $context -Prefix "stop" | Out-Null
try {
    $state = Read-GoodJobState -Context $context
    if (-not $state) { Write-GoodJobLog -Level WARN -Message "没有找到运行状态，服务可能已经停止"; exit 0 }
    $nodePath = [string](Get-StateValue -State $state -Name "nodePath")
    $crmPid = Get-StateValue -State $state -Name "crmPid"
    $communicationPid = Get-StateValue -State $state -Name "communicationPid"
    $databasePid = Get-StateValue -State $state -Name "databasePid"
    $databasePath = [string](Get-StateValue -State $state -Name "databasePath")
    foreach ($owned in @(
        @{ Name = "CRM"; Pid = $crmPid; Path = $nodePath; StartedAt = [string](Get-StateValue -State $state -Name "crmStartedAt") },
        @{ Name = "Communication"; Pid = $communicationPid; Path = $nodePath; StartedAt = [string](Get-StateValue -State $state -Name "communicationStartedAt") }
    )) {
        if ((Test-ProcessAlive -PidValue $owned.Pid) -and -not (Test-OwnedProcess -PidValue $owned.Pid -ExpectedPath $owned.Path -ExpectedStartedAt $owned.StartedAt)) {
            throw "拒绝停止 $($owned.Name)：无法确认 PID $($owned.Pid) 属于 GoodJob"
        }
        Stop-OwnedProcess -PidValue $owned.Pid -Name $owned.Name -ExpectedPath $owned.Path -ExpectedStartedAt $owned.StartedAt
    }
    if (-not $KeepDatabase -and (Test-ProcessAlive -PidValue $databasePid)) {
        $databaseStartedAt = [string](Get-StateValue -State $state -Name "databaseStartedAt")
        if (-not (Test-OwnedProcess -PidValue $databasePid -ExpectedPath $databasePath -ExpectedStartedAt $databaseStartedAt)) {
            throw "拒绝停止 MariaDB：无法确认 PID $databasePid 属于 GoodJob"
        }
        if (Test-Path -LiteralPath $context.RootClientFile) {
            try { Invoke-ExternalProcess -FilePath $context.MariaAdminExe -Arguments @("--defaults-extra-file=$($context.RootClientFile)", "shutdown") | Out-Null } catch { }
        }
        if (Test-ProcessAlive -PidValue $databasePid) {
            Stop-OwnedProcess -PidValue $databasePid -Name "MariaDB" -ExpectedPath $databasePath -ExpectedStartedAt $databaseStartedAt
        }
    }
    if (-not $KeepDatabase) { Remove-Item -LiteralPath $context.StateFile -Force -ErrorAction SilentlyContinue }
    Write-GoodJobLog -Level OK -Message $(if ($KeepDatabase) { "应用服务已停止，数据库保持运行" } else { "GoodJob CRM 已完全停止" })
} catch {
    Write-GoodJobFailure -ErrorRecord $_ -Stage "停止服务"
    exit 1
}
