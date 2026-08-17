@echo off
chcp 65001 >nul
title GoodJob CRM 一键启动
set "GOODJOB_PACKAGE_ROOT=%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0runtime\Start-GoodJob.ps1" -PackageRoot "%GOODJOB_PACKAGE_ROOT%"
if errorlevel 1 (
  echo.
  echo 启动失败。请查看上方原因，或双击 DIAGNOSE-GOODJOB.cmd。
  pause
)
