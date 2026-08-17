@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion

REM ════════════════════════════════════════════════════════════════
REM  GoodJob CRM Windows 启动器
REM  功能: 启动 MariaDB -> 启动 Node.js 后端 -> 打开浏览器
REM ════════════════════════════════════════════════════════════════

title GoodJob CRM

REM ── 路径定位 ──────────────────────────────────────────────────────
set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "APP_NAME=GoodJob CRM"

REM 数据目录
if "%GOODJOB_DATA_DIR%"=="" (
    set "DATA_DIR=%USERPROFILE%\.goodjob-crm"
) else (
    set "DATA_DIR=%GOODJOB_DATA_DIR%"
)

set "LOG_FILE=%DATA_DIR%\launcher.log"

REM 端口配置
set "API_PORT=4188"
set "MYSQL_PORT=13306"

REM ── 初始化数据目录 ────────────────────────────────────────────────
if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"
if not exist "%DATA_DIR%\mysql_data" mkdir "%DATA_DIR%\mysql_data"
if not exist "%DATA_DIR%\uploads" mkdir "%DATA_DIR%\uploads"
if not exist "%DATA_DIR%\backups" mkdir "%DATA_DIR%\backups"
if not exist "%DATA_DIR%\logs" mkdir "%DATA_DIR%\logs"

echo [%APP_NAME%] ═══════════════════════════════════════════
echo [%APP_NAME%]   %APP_NAME% 启动中...
echo [%APP_NAME%]   数据目录: %DATA_DIR%
echo [%APP_NAME%] ═══════════════════════════════════════════

REM ── 端口冲突检测 ──────────────────────────────────────────────────
:find_api_port
netstat -ano | findstr ":%API_PORT% " | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
    echo [%APP_NAME%] 端口 %API_PORT% 被占用，尝试 %API_PORT% + 1...
    set /a API_PORT+=1
    goto find_api_port
)

:find_mysql_port
netstat -ano | findstr ":%MYSQL_PORT% " | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
    set /a MYSQL_PORT+=1
    goto find_mysql_port
)

echo [%APP_NAME%] API 端口: %API_PORT%
echo [%APP_NAME%] MySQL 端口: %MYSQL_PORT%

REM ── Node.js 路径 ──────────────────────────────────────────────────
set "NODE_BIN=%SCRIPT_DIR%\node.exe"
if not exist "%NODE_BIN%" (
    where node >nul 2>&1
    if %errorlevel% equ 0 (
        for /f "delims=" %%i in ('where node') do set "NODE_BIN=%%i"
        echo [%APP_NAME%] 未找到内嵌 Node.js，使用系统 Node.js: !NODE_BIN!
    ) else (
        echo [%APP_NAME%] [ERROR] 未找到 Node.js 运行时！
        echo [%APP_NAME%] [ERROR] 请确保 node.exe 在: %SCRIPT_DIR%\node.exe
        pause
        exit /b 1
    )
)

REM ── MariaDB 便携版 ────────────────────────────────────────────────
set "MYSQLD_BIN=%SCRIPT_DIR%\mariadb\bin\mysqld.exe"
set "MYSQL_ADMIN=%SCRIPT_DIR%\mariadb\bin\mariadb-admin.exe"
set "MYSQL_CLIENT=%SCRIPT_DIR%\mariadb\bin\mariadb.exe"
set "MYSQL_DIR=%DATA_DIR%\mysql_data"

if not exist "%MYSQLD_BIN%" (
    echo [%APP_NAME%] [ERROR] 未找到 MariaDB: %MYSQLD_BIN%
    echo [%APP_NAME%] [ERROR] 请确保 MariaDB 便携版已正确安装
    pause
    exit /b 1
)

REM 首次初始化 MariaDB
if not exist "%MYSQL_DIR%\mysql" (
    echo [%APP_NAME%] 首次运行：初始化 MariaDB 数据目录...
    "%MYSQLD_BIN%" --initialize-insecure --datadir="%MYSQL_DIR%" --console 2>&1
    echo [%APP_NAME%] MariaDB 数据目录初始化完成
)

REM 启动 MariaDB
echo [%APP_NAME%] 启动 MariaDB (端口 %MYSQL_PORT%)...
start /b "" "%MYSQLD_BIN%" ^
    --datadir="%MYSQL_DIR%" ^
    --port=%MYSQL_PORT% ^
    --socket="%DATA_DIR%\mysql.sock" ^
    --pid-file="%DATA_DIR%\mysql.pid" ^
    --bind-address=127.0.0.1 ^
    --default-authentication-plugin=mysql_native_password ^
    --innodb-buffer-pool-size=128M ^
    --max-connections=20 ^
    --console

REM 等待 MariaDB 就绪
echo [%APP_NAME%] 等待 MariaDB 就绪...
set /a retries=30
:wait_mysql
"%MYSQL_CLIENT%" --socket="%DATA_DIR%\mysql.sock" -u root -e "SELECT 1" >nul 2>&1
if %errorlevel% equ 0 (
    echo [%APP_NAME%] MariaDB 已就绪
    goto mysql_ready
)
set /a retries-=1
if %retries% gtr 0 (
    timeout /t 1 /nobreak >nul
    goto wait_mysql
)
echo [%APP_NAME%] [ERROR] MariaDB 启动超时
pause
exit /b 1

:mysql_ready

REM ── 数据库初始化 ──────────────────────────────────────────────────
"%MYSQL_CLIENT%" --socket="%DATA_DIR%\mysql.sock" -u root -e "SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME='goodjob_crm'" -s 2>nul | findstr "goodjob_crm" >nul 2>&1
if %errorlevel% neq 0 (
    echo [%APP_NAME%] 首次运行：创建数据库...
    "%MYSQL_CLIENT%" --socket="%DATA_DIR%\mysql.sock" -u root -e "CREATE DATABASE IF NOT EXISTS goodjob_crm CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; CREATE USER IF NOT EXISTS 'goodjob'@'localhost' IDENTIFIED BY 'goodjob_local'; CREATE USER IF NOT EXISTS 'goodjob'@'127.0.0.1' IDENTIFIED BY 'goodjob_local'; GRANT ALL PRIVILEGES ON goodjob_crm.* TO 'goodjob'@'localhost'; GRANT ALL PRIVILEGES ON goodjob_crm.* TO 'goodjob'@'127.0.0.1'; FLUSH PRIVILEGES;"

    if exist "%SCRIPT_DIR%\backend\schema.mysql.sql" (
        echo [%APP_NAME%] 导入数据库结构...
        "%MYSQL_CLIENT%" --socket="%DATA_DIR%\mysql.sock" -u root goodjob_crm < "%SCRIPT_DIR%\backend\schema.mysql.sql"
    )

    if exist "%SCRIPT_DIR%\backend\goodjob_crm.full.sql" (
        echo [%APP_NAME%] 导入种子数据...
        "%MYSQL_CLIENT%" --socket="%DATA_DIR%\mysql.sock" -u root goodjob_crm < "%SCRIPT_DIR%\backend\goodjob_crm.full.sql"
    )

    echo [%APP_NAME%] 数据库初始化完成
) else (
    echo [%APP_NAME%] 数据库已存在，跳过初始化
)

REM ── 生成安全密钥（首次运行）──────────────────────────────────────
if not exist "%DATA_DIR%\.secrets" (
    echo [%APP_NAME%] 生成安全密钥...
    REM 使用 PowerShell 生成随机密钥
    for /f "delims=" %%i in ('powershell -Command "[System.Web.Security.Membership]::GeneratePassword(64,0)" 2^>nul ^| powershell -Command "$input ^| ForEach-Object { $_ -replace '[^a-zA-Z0-9]', '' }" ^| powershell -Command "$input -join ''"') do set "JWT_SECRET=%%i"
    if "!JWT_SECRET!"=="" set "JWT_SECRET=GoodJobCRMDefaultSecretKeyReplaceMe1234567890"

    (
        echo JWT_SECRET=!JWT_SECRET!
        echo PROVIDER_CREDENTIAL_KEY=GoodJobProviderKeyReplaceMe1234567890
        echo MYSQL_DATA_IMPORT_TOKEN=GoodJobMysqlTokenReplaceMe1234567890
        echo AGENT_JOB_ENCRYPTION_KEY=GoodJobAgentKeyReplaceMe1234567890
        echo TRADE_OBSERVATION_CURSOR_SECRET=GoodJobTradeObsReplaceMe1234567890
        echo MARKET_OPPORTUNITY_CURSOR_SECRET=GoodJobMarketOppReplaceMe1234567890
        echo PROSPECT_RUN_IDEMPOTENCY_SECRET=GoodJobProspectIdemReplaceMe1234567890
        echo PROSPECT_RUN_CURSOR_SECRET=GoodJobProspectCursorReplaceMe1234567890
        echo PROSPECT_EXECUTION_CLAIM_SECRET=GoodJobProspectClaimReplaceMe1234567890
        echo ORGANIZATION_IDENTITY_MASTER_SECRET=GoodJobOrgIdentityReplaceMe1234567890
        echo PROSPECT_SOURCE_RAW_ENVELOPE_SECRET=GoodJobProspectSourceReplaceMe1234567890
        echo PROSPECT_COVERAGE_MASTER_SECRET=GoodJobProspectCoverageReplaceMe1234567890
    ) > "%DATA_DIR%\.secrets"
    echo [%APP_NAME%] 密钥生成完成
)

REM ── 加载密钥和环境变量 ────────────────────────────────────────────
for /f "usebackq tokens=1,* delims==" %%a in ("%DATA_DIR%\.secrets") do set "%%a=%%b"

set CRM_STORE=mysql
set NODE_ENV=production
set PORT=%API_PORT%
set BACKEND_HOST=127.0.0.1
set CORS_ORIGINS=http://127.0.0.1:%API_PORT%,http://localhost:%API_PORT%
set SESSION_COOKIE_SECURE=false
set ENABLE_API_DOCS=false
set CRM_SEED_DEVELOPMENT_DATA=true
set PROSPECT_WORKER_ENABLED=false
set PROSPECT_QUEUE_REQUIRED=false
set REDIS_URL=
set DATABASE_URL=mysql://goodjob:goodjob_local@127.0.0.1:%MYSQL_PORT%/goodjob_crm
set FRONTEND_DIST=%SCRIPT_DIR%\frontend\dist
set AGENT_SKILLS_DIR=%SCRIPT_DIR%\agent-skills
set INITIAL_ADMIN_EMAIL=admin@goodjob.local
set INITIAL_ADMIN_PASSWORD=admin123456
set INITIAL_ADMIN_NAME=Admin

REM ── 启动后端 ──────────────────────────────────────────────────────
echo [%APP_NAME%] 启动后端服务 (端口 %API_PORT%)...
cd /d "%SCRIPT_DIR%\backend"
start /b "" "%NODE_BIN%" dist\server.js >> "%DATA_DIR%\logs\backend.log" 2>&1

REM 等待后端就绪
echo [%APP_NAME%] 等待后端就绪...
set /a retries=60
:wait_backend
powershell -Command "try { (Invoke-WebRequest -Uri 'http://127.0.0.1:%API_PORT%/api/health' -UseBasicParsing -TimeoutSec 2).StatusCode } catch { exit 1 }" >nul 2>&1
if %errorlevel% equ 0 (
    echo [%APP_NAME%] 后端已就绪
    goto backend_ready
)
set /a retries-=1
if %retries% gtr 0 (
    timeout /t 1 /nobreak >nul
    goto wait_backend
)
echo [%APP_NAME%] [ERROR] 后端启动超时，查看日志: %DATA_DIR%\logs\backend.log
pause
exit /b 1

:backend_ready

REM ── 打开浏览器 ────────────────────────────────────────────────────
echo [%APP_NAME%] 打开浏览器...
start "" "http://127.0.0.1:%API_PORT%"

echo.
echo [%APP_NAME%] ═══════════════════════════════════════════
echo [%APP_NAME%]   %APP_NAME% 已启动!
echo [%APP_NAME%]   访问地址: http://127.0.0.1:%API_PORT%
echo [%APP_NAME%]   默认账号: admin@goodjob.local
echo [%APP_NAME%]   默认密码: admin123456
echo [%APP_NAME%]   数据目录: %DATA_DIR%
echo [%APP_NAME%]   日志目录: %DATA_DIR%\logs\
echo [%APP_NAME%] ═══════════════════════════════════════════
echo.
echo 按任意键停止服务...
pause >nul

REM ── 优雅关闭 ──────────────────────────────────────────────────────
echo [%APP_NAME%] 正在关闭...
taskkill /f /im node.exe 2>nul
"%MYSQL_ADMIN%" --socket="%DATA_DIR%\mysql.sock" -u root shutdown 2>nul
echo [%APP_NAME%] 已关闭
exit /b 0
