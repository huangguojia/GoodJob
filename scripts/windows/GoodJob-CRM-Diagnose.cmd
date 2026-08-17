@echo off
chcp 65001 >nul
title GoodJob CRM 诊断
set "GOODJOB_PACKAGE_ROOT=%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0runtime\Diagnose-GoodJob.ps1" -PackageRoot "%GOODJOB_PACKAGE_ROOT%"
echo.
pause
