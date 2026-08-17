@echo off
chcp 65001 >nul
title 停止 GoodJob CRM
set "GOODJOB_PACKAGE_ROOT=%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0runtime\Stop-GoodJob.ps1" -PackageRoot "%GOODJOB_PACKAGE_ROOT%"
if errorlevel 1 pause
