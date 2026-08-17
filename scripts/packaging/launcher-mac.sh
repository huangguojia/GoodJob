#!/bin/bash
# ════════════════════════════════════════════════════════════════
#  GoodJob CRM Mac 启动器
#  功能: 启动 MariaDB → 启动 Node.js 后端 → 打开浏览器
# ════════════════════════════════════════════════════════════════

set -euo pipefail

# ── 路径定位 ──────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="GoodJob CRM"
DATA_DIR="${GOODJOB_DATA_DIR:-$HOME/.goodjob-crm}"
LOG_FILE="$DATA_DIR/launcher.log"

# 端口配置
API_PORT="${GOODJOB_API_PORT:-4188}"
MYSQL_PORT="${GOODJOB_MYSQL_PORT:-13306}"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log() { echo -e "${GREEN}[$APP_NAME]${NC} $1" | tee -a "$LOG_FILE" 2>/dev/null || echo -e "${GREEN}[$APP_NAME]${NC} $1"; }
warn() { echo -e "${YELLOW}[$APP_NAME]${NC} $1" | tee -a "$LOG_FILE" 2>/dev/null || echo -e "${YELLOW}[$APP_NAME]${NC} $1"; }
err()  { echo -e "${RED}[$APP_NAME]${NC} $1" | tee -a "$LOG_FILE" 2>/dev/null || echo -e "${RED}[$APP_NAME]${NC} $1"; }

# ── 初始化数据目录 ────────────────────────────────────────────────
mkdir -p "$DATA_DIR"
mkdir -p "$DATA_DIR/mysql_data"
mkdir -p "$DATA_DIR/uploads"
mkdir -p "$DATA_DIR/backups"
mkdir -p "$DATA_DIR/logs"

log "═══════════════════════════════════════════"
log "  $APP_NAME 启动中..."
log "  数据目录: $DATA_DIR"
log "═══════════════════════════════════════════"

# ── 端口冲突检测 ──────────────────────────────────────────────────
check_port() {
  local port=$1
  if lsof -i :$port -sTCP:LISTEN >/dev/null 2>&1; then
    return 1
  fi
  return 0
}

find_free_port() {
  local port=$1
  while ! check_port $port; do
    warn "端口 $port 被占用，尝试 $((port + 1))..."
    port=$((port + 1))
    if [ $port -gt $((port + 20)) ]; then
      err "无法找到可用端口"
      exit 1
    fi
  done
  echo $port
}

API_PORT=$(find_free_port $API_PORT)
MYSQL_PORT=$(find_free_port $MYSQL_PORT)
log "API 端口: $API_PORT"
log "MySQL 端口: $MYSQL_PORT"

# ── Node.js 路径 ──────────────────────────────────────────────────
NODE_BIN="$SCRIPT_DIR/node"
if [ ! -f "$NODE_BIN" ]; then
  # 尝试系统 Node.js
  if command -v node >/dev/null 2>&1; then
    NODE_BIN=$(which node)
    warn "未找到内嵌 Node.js，使用系统 Node.js: $NODE_BIN"
  else
    err "未找到 Node.js 运行时！"
    err "请确保 node 二进制文件在: $SCRIPT_DIR/node"
    exit 1
  fi
fi
log "Node.js: $NODE_BIN ($($NODE_BIN --version 2>/dev/null || echo 'unknown'))"

# ── MariaDB 便携版 ────────────────────────────────────────────────
MYSQLD_BIN="$SCRIPT_DIR/mariadb/bin/mysqld"
MYSQL_ADMIN="$SCRIPT_DIR/mariadb/bin/mariadb-admin"
MYSQL_CLIENT="$SCRIPT_DIR/mariadb/bin/mariadb"
MYSQL_DIR="$DATA_DIR/mysql_data"

MYSQLD_PID=""
MYSQLD_RUNNING=false

start_mariadb() {
  if [ ! -f "$MYSQLD_BIN" ]; then
    err "未找到 MariaDB: $MYSQLD_BIN"
    err "请确保 MariaDB 便携版已正确安装"
    exit 1
  fi

  # 首次初始化
  if [ ! -d "$MYSQL_DIR/mysql" ]; then
    log "首次运行：初始化 MariaDB 数据目录..."
    "$MYSQLD_BIN" --initialize-insecure \
      --datadir="$MYSQL_DIR" \
      --user="$(whoami)" 2>&1 | tee -a "$LOG_FILE"
    log "MariaDB 数据目录初始化完成"
  fi

  log "启动 MariaDB (端口 $MYSQL_PORT)..."
  "$MYSQLD_BIN" \
    --datadir="$MYSQL_DIR" \
    --port=$MYSQL_PORT \
    --socket="$DATA_DIR/mysql.sock" \
    --pid-file="$DATA_DIR/mysql.pid" \
    --user="$(whoami)" \
    --bind-address=127.0.0.1 \
    --skip-networking=false \
    --default-authentication-plugin=mysql_native_password \
    --innodb-buffer-pool-size=128M \
    --max-connections=20 \
    --quiet \
    &

  MYSQLD_PID=$!
  log "MariaDB PID: $MYSQLD_PID"

  # 等待 MariaDB 就绪
  log "等待 MariaDB 就绪..."
  local retries=30
  while [ $retries -gt 0 ]; do
    if "$MYSQL_CLIENT" \
      --socket="$DATA_DIR/mysql.sock" \
      -u root \
      -e "SELECT 1" >/dev/null 2>&1; then
      log "MariaDB 已就绪"
      MYSQLD_RUNNING=true
      break
    fi
    retries=$((retries - 1))
    sleep 1
  done

  if [ "$MYSQLD_RUNNING" = false ]; then
    err "MariaDB 启动超时"
    exit 1
  fi
}

# ── 数据库初始化 ──────────────────────────────────────────────────
init_database() {
  local DB_NAME="goodjob_crm"
  local DB_USER="goodjob"
  local DB_PASS="goodjob_local"

  # 检查数据库是否已存在
  local db_exists
  db_exists=$("$MYSQL_CLIENT" \
    --socket="$DATA_DIR/mysql.sock" \
    -u root \
    -e "SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME='$DB_NAME'" \
    -s 2>/dev/null || echo "")

  if [ -z "$db_exists" ]; then
    log "首次运行：创建数据库 $DB_NAME..."

    # 创建数据库和用户
    "$MYSQL_CLIENT" --socket="$DATA_DIR/mysql.sock" -u root <<EOF
CREATE DATABASE IF NOT EXISTS $DB_NAME CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
CREATE USER IF NOT EXISTS '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$DB_PASS';
GRANT ALL PRIVILEGES ON $DB_NAME.* TO '$DB_USER'@'localhost';
GRANT ALL PRIVILEGES ON $DB_NAME.* TO '$DB_USER'@'127.0.0.1';
FLUSH PRIVILEGES;
EOF

    # 导入 schema
    if [ -f "$SCRIPT_DIR/backend/schema.mysql.sql" ]; then
      log "导入数据库结构..."
      "$MYSQL_CLIENT" --socket="$DATA_DIR/mysql.sock" -u root "$DB_NAME" \
        < "$SCRIPT_DIR/backend/schema.mysql.sql" 2>&1 | tee -a "$LOG_FILE"
    fi

    # 导入种子数据
    if [ -f "$SCRIPT_DIR/backend/goodjob_crm.full.sql" ]; then
      log "导入种子数据..."
      "$MYSQL_CLIENT" --socket="$DATA_DIR/mysql.sock" -u root "$DB_NAME" \
        < "$SCRIPT_DIR/backend/goodjob_crm.full.sql" 2>&1 | tee -a "$LOG_FILE"
    fi

    log "数据库初始化完成"
  else
    log "数据库已存在，跳过初始化"
  fi
}

# ── 启动后端 ──────────────────────────────────────────────────────
BACKEND_PID=""
start_backend() {
  log "启动后端服务 (端口 $API_PORT)..."

  # 生成密钥（如果首次运行）
  if [ ! -f "$DATA_DIR/.secrets" ]; then
    log "生成安全密钥..."
    JWT_SECRET=$(openssl rand -hex 32)
    PROVIDER_KEY=$(openssl rand -hex 32)
    cat > "$DATA_DIR/.secrets" <<EOF
JWT_SECRET=$JWT_SECRET
PROVIDER_CREDENTIAL_KEY=$PROVIDER_KEY
MYSQL_DATA_IMPORT_TOKEN=$(openssl rand -hex 32)
AGENT_JOB_ENCRYPTION_KEY=$(openssl rand -hex 32)
TRADE_OBSERVATION_CURSOR_SECRET=$(openssl rand -hex 32)
MARKET_OPPORTUNITY_CURSOR_SECRET=$(openssl rand -hex 32)
PROSPECT_RUN_IDEMPOTENCY_SECRET=$(openssl rand -hex 32)
PROSPECT_RUN_CURSOR_SECRET=$(openssl rand -hex 32)
PROSPECT_EXECUTION_CLAIM_SECRET=$(openssl rand -hex 32)
ORGANIZATION_IDENTITY_MASTER_SECRET=$(openssl rand -hex 32)
PROSPECT_SOURCE_RAW_ENVELOPE_SECRET=$(openssl rand -hex 32)
PROSPECT_COVERAGE_MASTER_SECRET=$(openssl rand -hex 32)
EOF
    chmod 600 "$DATA_DIR/.secrets"
  fi

  # 加载密钥
  set -a
  source "$DATA_DIR/.secrets"
  set +a

  # 设置环境变量
  export CRM_STORE=mysql
  export NODE_ENV=production
  export PORT=$API_PORT
  export BACKEND_HOST=127.0.0.1
  export CORS_ORIGINS="http://127.0.0.1:$API_PORT,http://localhost:$API_PORT"
  export SESSION_COOKIE_SECURE=false
  export ENABLE_API_DOCS=false
  export CRM_SEED_DEVELOPMENT_DATA=true
  export PROSPECT_WORKER_ENABLED=false
  export PROSPECT_QUEUE_REQUIRED=false
  export REDIS_URL=""
  export DATABASE_URL="mysql://goodjob:goodjob_local@127.0.0.1:$MYSQL_PORT/goodjob_crm"
  export FRONTEND_DIST="$SCRIPT_DIR/frontend/dist"
  export AGENT_SKILLS_DIR="$SCRIPT_DIR/agent-skills"
  export INITIAL_ADMIN_EMAIL="admin@goodjob.local"
  export INITIAL_ADMIN_PASSWORD="admin123456"
  export INITIAL_ADMIN_NAME="Admin"

  cd "$SCRIPT_DIR/backend"
  "$NODE_BIN" dist/server.js >> "$DATA_DIR/logs/backend.log" 2>&1 &
  BACKEND_PID=$!
  log "后端 PID: $BACKEND_PID"

  # 等待后端就绪
  log "等待后端就绪..."
  local retries=60
  while [ $retries -gt 0 ]; do
    if curl -s "http://127.0.0.1:$API_PORT/api/health" >/dev/null 2>&1; then
      log "后端已就绪"
      break
    fi
    retries=$((retries - 1))
    sleep 1
  done

  if [ $retries -eq 0 ]; then
    err "后端启动超时，查看日志: $DATA_DIR/logs/backend.log"
    exit 1
  fi
}

# ── 优雅关闭 ──────────────────────────────────────────────────────
cleanup() {
  log "正在关闭..."
  if [ -n "$BACKEND_PID" ]; then
    log "停止后端 (PID: $BACKEND_PID)..."
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
  if [ "$MYSQLD_RUNNING" = true ]; then
    log "停止 MariaDB..."
    "$MYSQL_ADMIN" --socket="$DATA_DIR/mysql.sock" -u root shutdown 2>/dev/null || true
    kill "$MYSQLD_PID" 2>/dev/null || true
    wait "$MYSQLD_PID" 2>/dev/null || true
  fi
  log "已关闭"
  exit 0
}

trap cleanup SIGTERM SIGINT SIGHUP

# ── 主流程 ────────────────────────────────────────────────────────
start_mariadb
init_database
start_backend

# 打开浏览器
log "打开浏览器..."
if command -v open >/dev/null 2>&1; then
  open "http://127.0.0.1:$API_PORT"
fi

log ""
log "═══════════════════════════════════════════"
log "  $APP_NAME 已启动!"
log "  访问地址: http://127.0.0.1:$API_PORT"
log "  默认账号: admin@goodjob.local"
log "  默认密码: admin123456"
log "  数据目录: $DATA_DIR"
log "  日志目录: $DATA_DIR/logs/"
log "═══════════════════════════════════════════"
log ""
log "按 Ctrl+C 停止服务"

# 等待后端进程退出
wait "$BACKEND_PID" 2>/dev/null || true
cleanup
