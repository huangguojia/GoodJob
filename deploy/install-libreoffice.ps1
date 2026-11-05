<#
.SYNOPSIS
  安装 GoodJob 文件中心在 Windows 上需要的 Office 转换组件（LibreOffice）。

.DESCRIPTION
  文件中心的「在线预览 Office / WPS 文档」依赖 LibreOffice 无头转换（soffice）。
  Windows 上有两个必须注意的点：

  1. 一定用 soffice.com，不要用 soffice.exe。
     soffice.exe 是 GUI 入口，命令行调用会**立刻返回 0**，而转换还在后台跑，
     服务端读不到产物就会判定失败。soffice.com 是同目录下的控制台壳，会等转换结束。
     本脚本装完后会把探测结果打印出来，确认命中 .com。

  2. 不需要装 fontconfig，也不需要复制中文字体。
     Windows 上 LibreOffice 通过 GDI/DirectWrite 取系统字体，宋体/黑体/微软雅黑本来就有。

.PARAMETER Mode
  auto   （默认）有 winget 就用 winget，否则打印手动步骤
  winget 强制走 winget
  msi    用 -MsiPath 指定的离线 MSI 做「管理员安装」（解包到用户目录，不需要管理员权限）

.PARAMETER MsiPath
  离线 MSI 的路径。配合 -Mode msi 使用。

.PARAMETER WithPdfTools
  额外安装 poppler（提供 pdftoppm）和 ImageMagick。只有想看到缩略图/HEIC 预览才需要；
  不装也能预览 Office（正文 PDF 照常生成），只是列表里没有缩略图。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\install-libreoffice.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\install-libreoffice.ps1 -Mode msi -MsiPath D:\LibreOffice_26.2.0_Win_x86-64.msi
#>
[CmdletBinding()]
param(
  [ValidateSet("auto", "winget", "msi")]
  [string]$Mode = "auto",
  [string]$MsiPath = "",
  [switch]$WithPdfTools
)

$ErrorActionPreference = "Stop"

function Find-Soffice {
  $candidates = @(
    (Join-Path $env:ProgramFiles "LibreOffice\program\soffice.com"),
    (Join-Path ${env:ProgramFiles(x86)} "LibreOffice\program\soffice.com"),
    (Join-Path $env:LOCALAPPDATA "Programs\LibreOffice\program\soffice.com")
  ) | Where-Object { $_ -and (Test-Path $_) }
  return $candidates | Select-Object -First 1
}

function Test-Command($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

Write-Host "== GoodJob 文件中心 · Windows 依赖安装 ==" -ForegroundColor Cyan

$existing = Find-Soffice
if ($existing) {
  Write-Host "已检测到 LibreOffice：$existing" -ForegroundColor Green
} else {
  if ($Mode -eq "msi" -or ($Mode -eq "auto" -and $MsiPath)) {
    if (-not $MsiPath -or -not (Test-Path $MsiPath)) {
      throw "没有找到 MSI：$MsiPath"
    }
    # /a = administrative install：只解包、不写注册表、不要求管理员，
    # 效果等价于 macOS 上「把 .app 拖进 ~/Applications」。
    $target = Join-Path $env:LOCALAPPDATA "Programs\LibreOffice"
    Write-Host "解包到用户目录（无需管理员）：$target"
    $args = @("/a", "`"$MsiPath`"", "/qb", "TARGETDIR=`"$target`"")
    $proc = Start-Process msiexec.exe -ArgumentList $args -Wait -PassThru
    if ($proc.ExitCode -ne 0) { throw "msiexec 退出码 $($proc.ExitCode)" }
  } elseif (Test-Command winget) {
    Write-Host "通过 winget 安装 LibreOffice（会弹一次 UAC 授权）..."
    winget install --id TheDocumentFoundation.LibreOffice --exact `
      --accept-package-agreements --accept-source-agreements --silent
    if ($LASTEXITCODE -ne 0) {
      Write-Host "winget 安装未成功（退出码 $LASTEXITCODE）。可改用离线 MSI：" -ForegroundColor Yellow
      Write-Host "  1) 从 https://www.libreoffice.org/download/ 下载 Windows x86-64 MSI"
      Write-Host "  2) powershell -ExecutionPolicy Bypass -File deploy\install-libreoffice.ps1 -Mode msi -MsiPath <MSI 路径>"
      exit 1
    }
  } else {
    Write-Host "这台机器没有 winget。请手动安装后重跑本脚本：" -ForegroundColor Yellow
    Write-Host "  1) 下载 https://www.libreoffice.org/download/ 的 Windows x86-64 MSI"
    Write-Host "  2) powershell -ExecutionPolicy Bypass -File deploy\install-libreoffice.ps1 -Mode msi -MsiPath <MSI 路径>"
    exit 1
  }
}

# 服务端进程需要重启才会重新做能力探测（结果有缓存）
$soffice = Find-Soffice
if (-not $soffice) {
  Write-Host "安装流程结束，但没有探测到 soffice.com。" -ForegroundColor Red
  Write-Host "如果是 winget 刚装完，请重开一个终端再执行本脚本确认。" -ForegroundColor Yellow
  exit 1
}
Write-Host "OK  LibreOffice 可执行文件：$soffice" -ForegroundColor Green

if ($WithPdfTools) {
  if (Test-Command winget) {
    Write-Host "安装 poppler（pdftoppm，用于缩略图）..."
    winget install --id oschwartz10612.Poppler --exact --accept-package-agreements --accept-source-agreements --silent
    Write-Host "安装 ImageMagick（图片缩略图 / HEIC 兜底）..."
    winget install --id ImageMagick.ImageMagick --exact --accept-package-agreements --accept-source-agreements --silent
  } else {
    Write-Host "没有 winget，跳过 poppler / ImageMagick。缩略图缺失不影响在线预览正文。" -ForegroundColor Yellow
  }
}

Write-Host ""
Write-Host "下一步：" -ForegroundColor Cyan
Write-Host "  1) 重启后端服务（能力探测结果有缓存，不重启不生效）"
Write-Host "  2) 打开「文件中心 → 存储设置」，确认「在线预览能力」显示 Office 转换可用"
Write-Host ""
Write-Host "提示：不需要设置 FONTCONFIG_FILE。Windows 上 LibreOffice 直接用系统字体，"
Write-Host "      宋体 / 黑体 / 微软雅黑 都是系统自带的。"
