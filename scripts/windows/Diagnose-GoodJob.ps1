param(
    [string]$PackageRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$DataRoot = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"
Import-Module (Join-Path $PSScriptRoot "GoodJob.Runtime.psm1") -Force
$context = New-GoodJobContext -PackageRoot $PackageRoot -DataRoot $DataRoot
$report = Start-GoodJobLog -Context $context -Prefix "diagnosis"
Initialize-GoodJobDirectories -Context $context
Write-GoodJobLog -Message "GoodJob CRM 诊断开始"

$checks = [ordered]@{
    windowsX64 = ((Test-IsWindowsPlatform) -and [Environment]::Is64BitOperatingSystem)
    nodeRuntime = (Test-Path -LiteralPath $context.NodeExe)
    mariaRuntime = (Test-Path -LiteralPath $context.MariaExe)
    configuration = (Test-Path -LiteralPath $context.SecretsFile)
    databaseData = (Test-Path -LiteralPath (Join-Path $context.DatabaseRoot "mysql"))
}
$state = Read-GoodJobState -Context $context
if ($state) {
    $nodePath = [string](Get-StateValue -State $state -Name "nodePath")
    $crmPid = Get-StateValue -State $state -Name "crmPid"
    $communicationPid = Get-StateValue -State $state -Name "communicationPid"
    $databasePid = Get-StateValue -State $state -Name "databasePid"
    $checks.crmProcessOwned = Test-OwnedProcess -PidValue $crmPid -ExpectedPath $nodePath -ExpectedStartedAt ([string](Get-StateValue -State $state -Name "crmStartedAt"))
    $checks.communicationProcessOwned = Test-OwnedProcess -PidValue $communicationPid -ExpectedPath $nodePath -ExpectedStartedAt ([string](Get-StateValue -State $state -Name "communicationStartedAt"))
    $checks.databaseProcessOwned = Test-OwnedProcess -PidValue $databasePid -ExpectedPath ([string](Get-StateValue -State $state -Name "databasePath")) -ExpectedStartedAt ([string](Get-StateValue -State $state -Name "databaseStartedAt"))
    $apiPort = [int](Get-StateValue -State $state -Name "apiPort" -Default $context.ApiPort)
    $communicationPort = [int](Get-StateValue -State $state -Name "communicationPort" -Default $context.CommunicationPort)
    $checks.crmHealth = Wait-HttpReady -Url "http://127.0.0.1:$apiPort/api/health" -TimeoutSeconds 2
    $checks.communicationHealth = Wait-HttpReady -Url "http://127.0.0.1:$communicationPort/api/health/ready" -TimeoutSeconds 2
}
foreach ($entry in $checks.GetEnumerator()) {
    Write-GoodJobLog -Level $(if ($entry.Value) { "OK" } else { "ERROR" }) -Message "$($entry.Key)：$($entry.Value)"
}

Write-GoodJobLog -Message "最近日志尾部"
Get-ChildItem -LiteralPath $context.LogsRoot -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 6 | ForEach-Object {
        Add-Content -LiteralPath $report -Value "`r`n===== $($_.FullName) =====" -Encoding UTF8
        Get-Content -LiteralPath $_.FullName -Tail 80 -ErrorAction SilentlyContinue | Add-Content -LiteralPath $report -Encoding UTF8
    }
Write-Host "诊断报告：$report" -ForegroundColor Green
