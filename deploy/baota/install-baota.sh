#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PACKAGED_LAYOUT=false
if [[ -f "$SCRIPT_DIR/package.json" ]]; then
  SOURCE_DIR="${SOURCE_DIR:-$SCRIPT_DIR}"
  PACKAGED_LAYOUT=true
elif [[ -f "$SCRIPT_DIR/../../package.json" ]]; then
  SOURCE_DIR="${SOURCE_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
else
  SOURCE_DIR="${SOURCE_DIR:-$SCRIPT_DIR}"
fi

if [[ -f "$SCRIPT_DIR/database/bootstrap.sql.gz" ]]; then
  DATABASE_PACKAGE_DIR="$SCRIPT_DIR/database"
else
  DATABASE_PACKAGE_DIR="$SCRIPT_DIR/deploy/baota/database"
fi

APP_ROOT="${APP_ROOT:-/www/server/goodjob-crm}"
APP_USER="${APP_USER:-goodjob-crm}"
SERVICE_NAME="${SERVICE_NAME:-goodjob-crm}"
BACKEND_PORT="${BACKEND_PORT:-4188}"
AGENT_TRIGGER_POLL_MS="${AGENT_TRIGGER_POLL_MS:-60000}"
AGENT_MODEL_ROUTE_PLANNING="${AGENT_MODEL_ROUTE_PLANNING:-}"
AGENT_MODEL_ROUTE_EVALUATION="${AGENT_MODEL_ROUTE_EVALUATION:-}"
AGENT_DAILY_BUDGET_USD="${AGENT_DAILY_BUDGET_USD:-10}"
AGENT_MISSION_BUDGET_USD="${AGENT_MISSION_BUDGET_USD:-2}"
AGENT_INPUT_USD_PER_MILLION_TOKENS="${AGENT_INPUT_USD_PER_MILLION_TOKENS:-0.5}"
AGENT_OUTPUT_USD_PER_MILLION_TOKENS="${AGENT_OUTPUT_USD_PER_MILLION_TOKENS:-1.5}"
WHATSAPP_PLUGIN_SERVICE_NAME="${WHATSAPP_PLUGIN_SERVICE_NAME:-goodjob-crm-whatsapp}"
WHATSAPP_PLUGIN_PORT="${WHATSAPP_PLUGIN_PORT:-3100}"
WHATSAPP_PLUGIN_SESSION_MASTER_KEY="${WHATSAPP_PLUGIN_SESSION_MASTER_KEY:-}"
WHATSAPP_DB_HOST="${WHATSAPP_DB_HOST:-127.0.0.1}"
WHATSAPP_DB_PORT="${WHATSAPP_DB_PORT:-5432}"
WHATSAPP_DB_NAME="${WHATSAPP_DB_NAME:-goodjobcrm_whatsapp}"
WHATSAPP_DB_USER="${WHATSAPP_DB_USER:-goodjobcrm_whatsapp}"
WHATSAPP_DB_PASSWORD="${WHATSAPP_DB_PASSWORD:-}"
POSTGRES_ADMIN_USER="${POSTGRES_ADMIN_USER:-postgres}"
POSTGRES_ADMIN_PASSWORD="${POSTGRES_ADMIN_PASSWORD:-}"
DOMAIN="${DOMAIN:-}"
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
DB_NAME="${DB_NAME:-}"
DB_USER="${DB_USER:-}"
DB_PASSWORD="${DB_PASSWORD:-}"
MYSQL_ROOT_PASSWORD="${MYSQL_ROOT_PASSWORD:-}"
AUTO_CREATE_DATABASE="${AUTO_CREATE_DATABASE:-true}"
AUTO_CREATE_SITE="${AUTO_CREATE_SITE:-true}"
ENABLE_API_DOCS="${ENABLE_API_DOCS:-true}"
MYSQL_LOCAL_BACKUP_ENABLED="${MYSQL_LOCAL_BACKUP_ENABLED:-false}"
MYSQL_LOCAL_BACKUP_DIR="${MYSQL_LOCAL_BACKUP_DIR:-$APP_ROOT/shared/database-backups}"
MYSQL_LOCAL_BACKUP_RETENTION_DAYS="${MYSQL_LOCAL_BACKUP_RETENTION_DAYS:-7}"
EXTRA_ALLOWED_ORIGINS="${EXTRA_ALLOWED_ORIGINS:-}"
NON_INTERACTIVE="${NON_INTERACTIVE:-false}"
REUSE_EXISTING_DATABASE="${REUSE_EXISTING_DATABASE:-false}"
REPLACE_DATABASE="${REPLACE_DATABASE:-false}"
ALLOW_NONEMPTY_WEB_ROOT="${ALLOW_NONEMPTY_WEB_ROOT:-false}"
PROVISION_BETA_ADMINS="${PROVISION_BETA_ADMINS:-true}"
REMOVE_PRIMARY_ADMIN="${REMOVE_PRIMARY_ADMIN:-true}"
BETA_ADMIN_CREDENTIALS_FILE="${BETA_ADMIN_CREDENTIALS_FILE:-}"
VHOST_DIR="${VHOST_DIR:-/www/server/panel/vhost/nginx}"
VHOST_FILE="${VHOST_FILE:-}"
NGINX_MANAGED_DIR="${NGINX_MANAGED_DIR:-$VHOST_DIR/goodjob-crm}"
CHECK_PACKAGE_ONLY=false

RELEASE_ID="$(date +%Y%m%d%H%M%S)"
RELEASES_DIR="$APP_ROOT/releases"
SHARED_DIR="$APP_ROOT/shared"
ROLLBACK_DIR="$SHARED_DIR/rollback"
CURRENT_LINK="$APP_ROOT/current"
BETA_ADMIN_CREDENTIALS_FILE="${BETA_ADMIN_CREDENTIALS_FILE:-$SHARED_DIR/beta-admin-credentials.txt}"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
ENV_FILE="$SHARED_DIR/.env"
SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME.service"
WHATSAPP_PLUGIN_ENV_FILE="$SHARED_DIR/whatsapp-plugin.env"
WHATSAPP_PLUGIN_SERVICE_FILE="/etc/systemd/system/$WHATSAPP_PLUGIN_SERVICE_NAME.service"
BOOTSTRAP_FILE="$DATABASE_PACKAGE_DIR/bootstrap.sql.gz"
BOOTSTRAP_CHECKSUM_FILE="$DATABASE_PACKAGE_DIR/bootstrap.sql.gz.sha256"
PACKAGE_MANIFEST_FILE="$SOURCE_DIR/PACKAGE-MANIFEST.sha256"

PREVIOUS_RELEASE=""
CURRENT_SWITCHED=false
SERVICE_FILE_EXISTED=false
SERVICE_FILE_BACKUP=""
WHATSAPP_PLUGIN_SERVICE_FILE_EXISTED=false
WHATSAPP_PLUGIN_SERVICE_FILE_BACKUP=""
ENV_FILE_EXISTED=false
ENV_FILE_BACKUP=""
WHATSAPP_PLUGIN_ENV_FILE_EXISTED=false
WHATSAPP_PLUGIN_ENV_FILE_BACKUP=""
VHOST_CHANGED=false
VHOST_CREATED=false
VHOST_BACKUP=""
NGINX_INCLUDE_FILE=""
NGINX_INCLUDE_EXISTED=false
NGINX_INCLUDE_BACKUP=""
INSTALL_SUCCEEDED=false
MYSQL_BIN=""
PSQL_BIN=""
NGINX_BIN=""
NODE_BIN=""
NPM_BIN=""
WEB_ROOT=""

log() {
  printf '\n\033[1;34m[%s]\033[0m %s\n' "$(date '+%H:%M:%S')" "$*"
}

warn() {
  printf '\033[1;33m警告：%s\033[0m\n' "$*" >&2
}

die() {
  printf '\033[1;31m错误：%s\033[0m\n' "$*" >&2
  return 1
}

is_true() {
  case "${1:-}" in
    1|true|TRUE|True|yes|YES|Yes|y|Y|on|ON|On) return 0 ;;
    *) return 1 ;;
  esac
}

usage() {
  cat <<'EOF'
GoodJob CRM 宝塔 Linux 一键安装脚本

首次安装：
  sudo bash install-baota.sh

仅检查安装包：
  bash install-baota.sh --check-package

无人值守安装：
  sudo env NON_INTERACTIVE=true \
    DOMAIN=crm.example.com \
    DB_NAME=goodjob_crm \
    DB_USER=goodjob_crm \
    DB_PASSWORD='数据库密码' \
    bash install-baota.sh

重要开关：
  REUSE_EXISTING_DATABASE=true
      代码升级时复用已有数据库，不导入 bootstrap。

  ALLOW_NONEMPTY_WEB_ROOT=true
      允许 CRM 接管一个已有内容的宝塔站点。原文件不会删除，但会被隐藏。

  EXTRA_ALLOWED_ORIGINS=https://www.crm.example.com
      额外允许的正式访问来源，多个地址使用英文逗号分隔。
      只填写协议、域名和可选端口，不包含路径或末尾斜杠。

前置条件：
  - 域名 DNS 已指向服务器公网 IP。
  - 宝塔已安装 Nginx、MySQL 8.0+、Node.js 22+，并使用 systemd。当前不支持 MariaDB 10.x。
  - 首次安装使用空数据库；脚本会自动创建数据库和网站配置。
  - Node.js 22+、npm、Nginx、MySQL 客户端、systemd 可用。
  - 推荐先在宝塔为网站启用 HTTPS。
EOF
}

prompt_value() {
  local variable_name="$1"
  local prompt_text="$2"
  local default_value="${3:-}"
  local current_value="${!variable_name:-}"
  local answer=""
  if [[ -n "$current_value" ]]; then
    return
  fi
  if is_true "$NON_INTERACTIVE"; then
    [[ -n "$default_value" ]] || die "无人值守模式缺少 $variable_name"
    printf -v "$variable_name" '%s' "$default_value"
    return
  fi
  read -r -p "$prompt_text${default_value:+ [$default_value]}: " answer
  printf -v "$variable_name" '%s' "${answer:-$default_value}"
}

prompt_secret() {
  local variable_name="$1"
  local prompt_text="$2"
  local current_value="${!variable_name:-}"
  local answer=""
  [[ -n "$current_value" ]] && return
  is_true "$NON_INTERACTIVE" && die "无人值守模式缺少 $variable_name"
  read -r -s -p "$prompt_text: " answer
  printf '\n'
  printf -v "$variable_name" '%s' "$answer"
}

confirm_action() {
  local prompt_text="$1"
  local answer=""
  if is_true "$NON_INTERACTIVE"; then
    return 1
  fi
  read -r -p "$prompt_text [y/N]: " answer
  is_true "$answer"
}

find_binary() {
  local name="$1"
  shift
  local candidate=""
  if command -v "$name" >/dev/null 2>&1; then
    command -v "$name"
    return
  fi
  for candidate in "$@"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  return 1
}

checksum_value() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    die "缺少 sha256sum 或 shasum，无法验证安装包"
  fi
}

verify_package_manifest() {
  local expected=""
  local actual=""
  local relative_path=""
  local line=""
  local verified_count=0
  local expected_paths=""
  local actual_paths=""
  [[ "$PACKAGED_LAYOUT" == true ]] || return 0
  [[ -f "$PACKAGE_MANIFEST_FILE" ]] \
    || die "安装包缺少完整性清单：$PACKAGE_MANIFEST_FILE"

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -n "$line" ]] || continue
    expected="${line%%  *}"
    relative_path="${line#*  }"
    [[ "$relative_path" != "$line" && "$expected" =~ ^[0-9A-Fa-f]{64}$ ]] \
      || die "完整性清单格式错误：$line"
    [[ "$relative_path" != /* \
      && "$relative_path" != ".." \
      && "$relative_path" != ../* \
      && "$relative_path" != */../* \
      && "$relative_path" != */.. ]] \
      || die "完整性清单含不安全路径：$relative_path"
    [[ -f "$SOURCE_DIR/$relative_path" ]] \
      || die "安装包缺少清单文件：$relative_path"
    actual="$(checksum_value "$SOURCE_DIR/$relative_path")"
    [[ "$actual" == "$expected" ]] \
      || die "安装包文件校验失败：$relative_path"
    verified_count=$((verified_count + 1))
  done < "$PACKAGE_MANIFEST_FILE"
  (( verified_count > 0 )) || die "安装包完整性清单为空"

  expected_paths="$(mktemp)"
  actual_paths="$(mktemp)"
  awk 'NF { print substr($0, 67) }' "$PACKAGE_MANIFEST_FILE" | LC_ALL=C sort > "$expected_paths"
  find "$SOURCE_DIR" -type f ! -path "$PACKAGE_MANIFEST_FILE" -print \
    | sed "s#^$SOURCE_DIR/##" | LC_ALL=C sort > "$actual_paths"
  if ! cmp -s "$expected_paths" "$actual_paths"; then
    rm -f "$expected_paths" "$actual_paths"
    die "安装包文件列表与完整性清单不一致，可能上传或解压不完整"
  fi
  rm -f "$expected_paths" "$actual_paths"
  printf '完整性清单校验通过：%s 个文件。\n' "$verified_count"
}

verify_package() {
  local expected=""
  local actual=""
  for required_file in \
    "$SOURCE_DIR/package.json" \
    "$SOURCE_DIR/package-lock.json" \
    "$SOURCE_DIR/backend/package.json" \
    "$SOURCE_DIR/backend/dist/migrate-mysql.js" \
    "$SOURCE_DIR/backend/dist/mysql-data-import.js" \
    "$SOURCE_DIR/backend/dist/provision-beta-admins.js" \
    "$SOURCE_DIR/frontend/package.json" \
    "$SOURCE_DIR/whatsapp-plugin/package.json" \
    "$SOURCE_DIR/whatsapp-plugin/package-lock.json" \
    "$SOURCE_DIR/LICENSE" \
    "$SOURCE_DIR/NOTICE" \
    "$SOURCE_DIR/THIRD_PARTY_NOTICES.md" \
    "$SOURCE_DIR/agent-knowledge/00-system-contract.json" \
    "$SOURCE_DIR/agent-knowledge/30-prospecting.json" \
    "$SOURCE_DIR/agent-skills/system-overview/skill.json" \
    "$SOURCE_DIR/agent-skills/system-overview/SKILL.md" \
    "$SOURCE_DIR/whatsapp-plugin/LICENSE" \
    "$SOURCE_DIR/whatsapp-plugin/THIRD_PARTY_NOTICES.md" \
    "$BOOTSTRAP_FILE" \
    "$BOOTSTRAP_CHECKSUM_FILE"; do
  [[ -f "$required_file" ]] || die "安装包缺少文件：$required_file"
done
[[ -f "$SOURCE_DIR/whatsapp-plugin/src/server/index.ts" ]] || die "安装包缺少 WhatsApp 插件服务源码"
  grep -Fq '"name": "goodjob-crm"' "$SOURCE_DIR/package-lock.json" \
    || die "根 package-lock.json 与 CRM 项目不匹配"
  grep -Fq '"name": "whatsapp-crm-plugin"' "$SOURCE_DIR/whatsapp-plugin/package-lock.json" \
    || die "Communication package-lock.json 与插件项目不匹配"
  verify_package_manifest
  gzip -t "$BOOTSTRAP_FILE" || die "bootstrap.sql.gz 已损坏"
  expected="$(awk 'NF {print $1; exit}' "$BOOTSTRAP_CHECKSUM_FILE")"
  actual="$(checksum_value "$BOOTSTRAP_FILE")"
  [[ "$actual" == "$expected" ]] || die "bootstrap.sql.gz 校验失败"

  local insert_tables=""
  local admin_email_count=0
  local scrypt_count=0
  insert_tables="$(gzip -dc "$BOOTSTRAP_FILE" \
    | sed -n -E 's/^(INSERT|REPLACE) INTO `?([^` (]+).*/\2/p' \
    | sort -u)"
  [[ "$insert_tables" == "users" ]] || die "bootstrap 含 users 以外的数据表写入"
  admin_email_count="$(gzip -dc "$BOOTSTRAP_FILE" \
    | grep -Eo "admin@goodjob\\.com" \
    | sort -u \
    | wc -l \
    | tr -d ' ')"
  scrypt_count="$(gzip -dc "$BOOTSTRAP_FILE" | grep -Eo "scrypt\\$" | wc -l | tr -d ' ')"
  [[ "$admin_email_count" == "1" ]] || die "bootstrap 中默认管理员数量不正确"
  [[ "$scrypt_count" == "1" ]] || die "bootstrap 中管理员密码哈希数量不正确"
  if gzip -dc "$BOOTSTRAP_FILE" \
    | grep -Eqi "(super_admin|beta-admin-[0-9]{2}@goodjob-crm\\.com|super@goodjob\\.com|INITIAL_ADMIN_PASSWORD)"; then
    die "bootstrap 中发现公测管理员或超级管理员标记"
  fi
  grep -Fq 'credentials.length !== 40' "$SOURCE_DIR/backend/dist/provision-beta-admins.js" \
    || die "安装包缺少 40 个管理员完整性校验"
  grep -Fq 'REMOVE_PRIMARY_ADMIN' "$SOURCE_DIR/backend/dist/provision-beta-admins.js" \
    || die "安装包缺少旧通用管理员删除逻辑"
  grep -Fq 'stop_existing_services' "$SOURCE_DIR/install-baota.sh" \
    || die "安装包缺少旧服务停止逻辑"
  grep -Fq 'backend/dist/migrate-mysql.js' "$SOURCE_DIR/install-baota.sh" \
    || die "安装包缺少 MySQL 增量迁移入口"
  grep -Fq 'MYSQL_DATA_IMPORT_TOKEN' "$SOURCE_DIR/install-baota.sh" \
    || die "安装包缺少 MySQL 文件迁移授权配置"
}

validate_identifier() {
  local label="$1"
  local value="$2"
  [[ "$value" =~ ^[A-Za-z0-9_]+$ ]] || die "$label 只能包含英文字母、数字和下划线"
}

validate_system_name() {
  local label="$1"
  local value="$2"
  [[ "$value" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] \
    || die "$label 格式不正确：$value"
}

validate_domain() {
  [[ "$DOMAIN" != http://* && "$DOMAIN" != https://* && "$DOMAIN" != */* ]] \
    || die "DOMAIN 只填写域名，不包含协议和路径"
  [[ "$DOMAIN" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]] \
    || die "域名格式不正确：$DOMAIN"
}

normalize_extra_allowed_origins() {
  local raw_origin=""
  local origin=""
  local normalized=""
  local origins=()
  [[ -n "$EXTRA_ALLOWED_ORIGINS" ]] || return 0
  [[ "$EXTRA_ALLOWED_ORIGINS" != *$'\n'* && "$EXTRA_ALLOWED_ORIGINS" != *$'\r'* ]] \
    || die "EXTRA_ALLOWED_ORIGINS 不能包含换行"
  IFS=',' read -r -a origins <<< "$EXTRA_ALLOWED_ORIGINS"
  for raw_origin in "${origins[@]}"; do
    origin="${raw_origin#"${raw_origin%%[![:space:]]*}"}"
    origin="${origin%"${origin##*[![:space:]]}"}"
    [[ "$origin" =~ ^https?://([A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:]+\])(:[0-9]{1,5})?$ ]] \
      || die "额外请求来源格式不正确：$origin"
    normalized="${normalized:+$normalized,}$origin"
  done
  EXTRA_ALLOWED_ORIGINS="$normalized"
}

validate_port() {
  local label="$1"
  local value="$2"
  [[ "$value" =~ ^[0-9]+$ ]] || die "$label 必须是数字"
  (( value >= 1 && value <= 65535 )) || die "$label 必须在 1-65535 之间"
}

generate_secret() {
  openssl rand -hex 48
}

generate_plugin_master_key() {
  openssl rand -base64 32 | tr -d '\n'
}

read_existing_env_value() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 0
  sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n 1
}

ensure_secret() {
  local name="$1"
  local existing=""
  if [[ -n "${!name:-}" ]]; then
    return
  fi
  existing="$(read_existing_env_value "$name")"
  printf -v "$name" '%s' "${existing:-$(generate_secret)}"
}

ensure_plugin_master_key() {
  local existing=""
  if [[ -n "$WHATSAPP_PLUGIN_SESSION_MASTER_KEY" ]]; then
    return
  fi
  if [[ -f "$WHATSAPP_PLUGIN_ENV_FILE" ]]; then
    existing="$(sed -n 's/^SESSION_MASTER_KEY=//p' "$WHATSAPP_PLUGIN_ENV_FILE" | tail -n 1)"
  fi
  WHATSAPP_PLUGIN_SESSION_MASTER_KEY="${existing:-$(generate_plugin_master_key)}"
  "$NODE_BIN" -e 'const value=Buffer.from(process.argv[1], "base64"); if (value.length !== 32) process.exit(1)' "$WHATSAPP_PLUGIN_SESSION_MASTER_KEY" \
    || die "WhatsApp 插件 SESSION_MASTER_KEY 必须是 32 字节 Base64 密钥"
}

mysql_query() {
  MYSQL_PWD="$DB_PASSWORD" "$MYSQL_BIN" \
    --protocol=TCP \
    --connect-timeout=10 \
    --default-character-set=utf8mb4 \
    -h "$DB_HOST" \
    -P "$DB_PORT" \
    -u "$DB_USER" \
    -N -B "$@"
}

mysql_root_query() {
  if [[ -n "$MYSQL_ROOT_PASSWORD" ]]; then
    MYSQL_PWD="$MYSQL_ROOT_PASSWORD" "$MYSQL_BIN" \
      --protocol=TCP --connect-timeout=10 --default-character-set=utf8mb4 \
      -h "$DB_HOST" -P "$DB_PORT" -u root "$@"
  else
    "$MYSQL_BIN" --protocol=socket --default-character-set=utf8mb4 -u root "$@"
  fi
}

postgres_escape_literal() {
  local value="$1"
  value="${value//\'/\'\'}"
  printf '%s' "$value"
}

postgres_admin_query() {
  local args=("$@")
  if [[ -n "$POSTGRES_ADMIN_PASSWORD" ]]; then
    PGPASSWORD="$POSTGRES_ADMIN_PASSWORD" "$PSQL_BIN" \
      --host "$WHATSAPP_DB_HOST" \
      --port "$WHATSAPP_DB_PORT" \
      --username "$POSTGRES_ADMIN_USER" \
      --dbname postgres \
      --set ON_ERROR_STOP=1 \
      "${args[@]}"
    return
  fi
  runuser -u postgres -- "$PSQL_BIN" \
    --dbname postgres \
    --set ON_ERROR_STOP=1 \
    "${args[@]}"
}

ensure_postgres_database() {
  [[ -n "$PSQL_BIN" ]] || die "未找到 PostgreSQL 客户端 psql。请在宝塔安装 PostgreSQL 14+ 后重试"
  id postgres >/dev/null 2>&1 \
    || die "未找到 postgres 系统用户，请确认 PostgreSQL 服务已正确安装"
  validate_identifier "WHATSAPP_DB_NAME" "$WHATSAPP_DB_NAME"
  validate_identifier "WHATSAPP_DB_USER" "$WHATSAPP_DB_USER"
  validate_port "WHATSAPP_DB_PORT" "$WHATSAPP_DB_PORT"
  [[ -n "$WHATSAPP_DB_PASSWORD" ]] || WHATSAPP_DB_PASSWORD="$(generate_secret)"
  local escaped_password
  local role_exists
  local database_exists
  escaped_password="$(postgres_escape_literal "$WHATSAPP_DB_PASSWORD")"
  role_exists="$(postgres_admin_query -Atqc "SELECT 1 FROM pg_roles WHERE rolname='$(postgres_escape_literal "$WHATSAPP_DB_USER")';")"
  if [[ "$role_exists" != "1" ]]; then
    postgres_admin_query -c "CREATE ROLE \"$WHATSAPP_DB_USER\" LOGIN PASSWORD '$escaped_password';"
  else
    postgres_admin_query -c "ALTER ROLE \"$WHATSAPP_DB_USER\" LOGIN PASSWORD '$escaped_password';"
  fi
  database_exists="$(postgres_admin_query -Atqc "SELECT 1 FROM pg_database WHERE datname='$(postgres_escape_literal "$WHATSAPP_DB_NAME")';")"
  if [[ "$database_exists" != "1" ]]; then
    postgres_admin_query -c "CREATE DATABASE \"$WHATSAPP_DB_NAME\" OWNER \"$WHATSAPP_DB_USER\";"
  fi
  postgres_admin_query -c "GRANT ALL PRIVILEGES ON DATABASE \"$WHATSAPP_DB_NAME\" TO \"$WHATSAPP_DB_USER\";"
}

mysql_escape_literal() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\'/\'\'}"
  printf '%s' "$value"
}

ensure_database() {
  if ! is_true "$AUTO_CREATE_DATABASE"; then
    return 0
  fi
  # 宝塔中已经创建并可登录的数据库无需 root 权限，直接复用即可。
  if mysql_query -e "SELECT 1;" >/dev/null 2>&1; then
    log "检测到业务数据库和用户已经可用，跳过 root 自动创建"
    return 0
  fi
  [[ "$DB_HOST" == "127.0.0.1" || "$DB_HOST" == "localhost" ]] \
    || die "AUTO_CREATE_DATABASE=true 时 DB_HOST 必须是本机 127.0.0.1 或 localhost"
  local escaped_password
  escaped_password="$(mysql_escape_literal "$DB_PASSWORD")"
  mysql_root_query <<SQL \
    || die "无法使用 MySQL root 权限自动创建数据库。请填写 MYSQL_ROOT_PASSWORD，或确认 root 可通过本机 socket 登录。"
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$(mysql_escape_literal "$DB_USER")'@'127.0.0.1' IDENTIFIED BY '$escaped_password';
ALTER USER '$(mysql_escape_literal "$DB_USER")'@'127.0.0.1' IDENTIFIED BY '$escaped_password';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$(mysql_escape_literal "$DB_USER")'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL
}

mysql_database_query() {
  mysql_query "$DB_NAME" "$@"
}

database_table_count() {
  mysql_query -e \
    "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${DB_NAME}';"
}

wait_for_backend_health() {
  local response=""
  local attempt=0
  for attempt in {1..40}; do
    response="$(curl -fsS "http://127.0.0.1:$BACKEND_PORT/api/health" 2>/dev/null || true)"
    if printf '%s' "$response" \
      | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true.*"store"[[:space:]]*:[[:space:]]*"mysql"'; then
      return 0
    fi
    sleep 2
  done
  return 1
}

wait_for_plugin_health() {
  local attempt=0
  for attempt in {1..40}; do
    if curl -fsS "http://127.0.0.1:$WHATSAPP_PLUGIN_PORT/api/health" 2>/dev/null \
      | grep -Eq '"ready"[[:space:]]*:[[:space:]]*true'; then
      return 0
    fi
    sleep 2
  done
  return 1
}

reload_nginx() {
  if "$NGINX_BIN" -s reload; then
    return
  fi
  if [[ -x /etc/init.d/nginx ]]; then
    /etc/init.d/nginx reload
    return
  fi
  systemctl reload nginx
}

stop_existing_services() {
  local service=""
  local port=""
  local listener=""
  local attempt=0
  for service in "$SERVICE_NAME" "$WHATSAPP_PLUGIN_SERVICE_NAME"; do
    if systemctl cat "$service" >/dev/null 2>&1 || systemctl is-active --quiet "$service"; then
      systemctl stop "$service"
    fi
  done
  for attempt in {1..30}; do
    listener=""
    if command -v ss >/dev/null 2>&1; then
      for port in "$BACKEND_PORT" "$WHATSAPP_PLUGIN_PORT"; do
        if ss -lntp 2>/dev/null | awk -v suffix=":$port" '$4 ~ suffix "$" {found=1} END {exit !found}'; then
          listener="port $port"
          break
        fi
      done
    fi
    [[ -z "$listener" ]] && return 0
    sleep 1
  done
  die "旧项目停止后端口仍被占用：$listener。请检查残留进程后重试"
}

restore_files_after_failure() {
  if [[ "$VHOST_CREATED" == true ]]; then
    rm -f "$VHOST_FILE"
  elif [[ "$VHOST_CHANGED" == true && -f "$VHOST_BACKUP" ]]; then
    cp -p "$VHOST_BACKUP" "$VHOST_FILE"
  fi
  if [[ -n "$NGINX_INCLUDE_FILE" ]]; then
    if [[ "$NGINX_INCLUDE_EXISTED" == true && -f "$NGINX_INCLUDE_BACKUP" ]]; then
      cp -p "$NGINX_INCLUDE_BACKUP" "$NGINX_INCLUDE_FILE"
    elif [[ "$NGINX_INCLUDE_EXISTED" == false ]]; then
      rm -f "$NGINX_INCLUDE_FILE"
    fi
  fi
  if [[ "$ENV_FILE_EXISTED" == true && -f "$ENV_FILE_BACKUP" ]]; then
    cp -p "$ENV_FILE_BACKUP" "$ENV_FILE"
  elif [[ "$ENV_FILE_EXISTED" == false ]]; then
    rm -f "$ENV_FILE"
  fi
  if [[ "$SERVICE_FILE_EXISTED" == true && -f "$SERVICE_FILE_BACKUP" ]]; then
    cp -p "$SERVICE_FILE_BACKUP" "$SERVICE_FILE"
  elif [[ "$SERVICE_FILE_EXISTED" == false ]]; then
    rm -f "$SERVICE_FILE"
    systemctl disable "$SERVICE_NAME" >/dev/null 2>&1
  fi
  if [[ "$WHATSAPP_PLUGIN_ENV_FILE_EXISTED" == true && -f "$WHATSAPP_PLUGIN_ENV_FILE_BACKUP" ]]; then
    cp -p "$WHATSAPP_PLUGIN_ENV_FILE_BACKUP" "$WHATSAPP_PLUGIN_ENV_FILE"
  elif [[ "$WHATSAPP_PLUGIN_ENV_FILE_EXISTED" == false ]]; then
    rm -f "$WHATSAPP_PLUGIN_ENV_FILE"
  fi
  if [[ "$WHATSAPP_PLUGIN_SERVICE_FILE_EXISTED" == true && -f "$WHATSAPP_PLUGIN_SERVICE_FILE_BACKUP" ]]; then
    cp -p "$WHATSAPP_PLUGIN_SERVICE_FILE_BACKUP" "$WHATSAPP_PLUGIN_SERVICE_FILE"
  elif [[ "$WHATSAPP_PLUGIN_SERVICE_FILE_EXISTED" == false ]]; then
    rm -f "$WHATSAPP_PLUGIN_SERVICE_FILE"
    systemctl disable "$WHATSAPP_PLUGIN_SERVICE_NAME" >/dev/null 2>&1
  fi
  if [[ "$CURRENT_SWITCHED" == true ]]; then
    if [[ -n "$PREVIOUS_RELEASE" && -d "$PREVIOUS_RELEASE" ]]; then
      ln -sfn "$PREVIOUS_RELEASE" "$CURRENT_LINK"
    else
      rm -f "$CURRENT_LINK"
    fi
  fi
}

on_error() {
  local exit_code=$?
  local line_number="${BASH_LINENO[0]:-unknown}"
  trap - ERR
  set +e
  printf '\n\033[1;31m安装在第 %s 行失败，退出码 %s。\033[0m\n' \
    "$line_number" "$exit_code" >&2
  restore_files_after_failure
  systemctl daemon-reload >/dev/null 2>&1
  if [[ -n "$PREVIOUS_RELEASE" && -d "$PREVIOUS_RELEASE" ]]; then
    systemctl restart "$SERVICE_NAME" >/dev/null 2>&1
    systemctl restart "$WHATSAPP_PLUGIN_SERVICE_NAME" >/dev/null 2>&1 || true
  else
    systemctl stop "$SERVICE_NAME" >/dev/null 2>&1
    systemctl stop "$WHATSAPP_PLUGIN_SERVICE_NAME" >/dev/null 2>&1 || true
  fi
  if [[ -n "$NGINX_BIN" && -x "$NGINX_BIN" ]]; then
    "$NGINX_BIN" -t >/dev/null 2>&1 && reload_nginx >/dev/null 2>&1
  fi
  if command -v journalctl >/dev/null 2>&1; then
    printf '\n最近的后端服务日志：\n' >&2
    journalctl -u "$SERVICE_NAME" -n 60 --no-pager >&2
  fi
  exit "$exit_code"
}

trap on_error ERR

for argument in "$@"; do
  case "$argument" in
    --help|-h)
      usage
      exit 0
      ;;
    --check-package)
      CHECK_PACKAGE_ONLY=true
      ;;
    *)
      die "未知参数：$argument"
      ;;
  esac
done

verify_package
if [[ "$CHECK_PACKAGE_ONLY" == true ]]; then
  printf '安装包校验通过：初始化结构、40 个团队管理员恢复、旧管理员删除和停服升级逻辑完整。\n'
  exit 0
fi

[[ "$(id -u)" -eq 0 ]] || die "请使用 sudo bash $0 运行"
[[ "$(uname -s)" == "Linux" ]] || die "此脚本仅支持 Linux"
command -v systemctl >/dev/null 2>&1 || die "服务器未使用 systemd"
command -v curl >/dev/null 2>&1 || die "缺少 curl"
command -v rsync >/dev/null 2>&1 || die "缺少 rsync，请先安装"
command -v openssl >/dev/null 2>&1 || die "缺少 openssl，请先安装"

node_candidates=()
if command -v node >/dev/null 2>&1; then
  node_candidates+=("$(command -v node)")
fi
while IFS= read -r candidate; do
  node_candidates+=("$candidate")
done < <(compgen -G "/www/server/nodejs/*/bin/node" || true)
for candidate in "${node_candidates[@]}"; do
  candidate_major="$("$candidate" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0')"
  if (( candidate_major >= 22 )); then
    NODE_BIN="$candidate"
    if [[ -x "$(dirname "$candidate")/npm" ]]; then
      NPM_BIN="$(dirname "$candidate")/npm"
    fi
    break
  fi
done
if [[ -z "$NPM_BIN" ]]; then
  NPM_BIN="$(find_binary npm /www/server/nodejs/*/bin/npm 2>/dev/null || true)"
fi
MYSQL_BIN="$(find_binary mysql /www/server/mysql/bin/mysql /usr/bin/mysql 2>/dev/null || true)"
PSQL_BIN="$(find_binary psql /www/server/pgsql/bin/psql /usr/bin/psql 2>/dev/null || true)"
# 宝塔和系统可能同时安装 Nginx；必须优先使用宝塔版本及其配置根目录。
if [[ -x /www/server/nginx/sbin/nginx ]]; then
  NGINX_BIN=/www/server/nginx/sbin/nginx
else
  NGINX_BIN="$(find_binary nginx /usr/sbin/nginx 2>/dev/null || true)"
fi

[[ -n "$NODE_BIN" ]] || die "未找到 Node.js。请在宝塔软件商店安装 Node.js 22+，并确保 node 可执行"
[[ -n "$NPM_BIN" ]] || die "未找到 npm。请在宝塔软件商店安装 Node.js 22+"
[[ -n "$MYSQL_BIN" ]] || die "未找到 MySQL 客户端"
[[ -n "$PSQL_BIN" ]] || die "未找到 PostgreSQL 客户端。请在宝塔安装 PostgreSQL 14+，WhatsApp 生产环境不使用 PGlite"
[[ -n "$NGINX_BIN" ]] || die "未找到宝塔 Nginx"
node_major="$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0')"
[[ "$node_major" =~ ^[0-9]+$ ]] && (( node_major >= 22 )) \
  || die "Node.js 版本过低，需要 22+"
crm_package_name="$("$NPM_BIN" --prefix "$SOURCE_DIR" pkg get name 2>/dev/null | tr -d '\r\n"')"
communication_package_name="$("$NPM_BIN" --prefix "$SOURCE_DIR/whatsapp-plugin" pkg get name 2>/dev/null | tr -d '\r\n"')"
[[ "$crm_package_name" == "goodjob-crm" ]] \
  || die "npm 未定位到 CRM package.json，请检查安装包目录和 npm --prefix 参数"
[[ "$communication_package_name" == "whatsapp-crm-plugin" ]] \
  || die "npm 未定位到 Communication package.json"
postgres_major="$("$PSQL_BIN" --version | sed -nE 's/.* ([0-9]+)(\..*)?$/\1/p')"
[[ "$postgres_major" =~ ^[0-9]+$ ]] && (( postgres_major >= 14 )) \
  || die "PostgreSQL 客户端版本过低，需要 14+"

prompt_value DOMAIN "请输入宝塔网站绑定的域名"
prompt_value DB_NAME "请输入要创建的数据库名" "goodjob_crm"
prompt_value DB_USER "请输入要创建的业务用户名" "$DB_NAME"
prompt_secret DB_PASSWORD "请输入数据库密码"

validate_domain
normalize_extra_allowed_origins
validate_identifier "DB_NAME" "$DB_NAME"
validate_identifier "DB_USER" "$DB_USER"
validate_system_name "APP_USER" "$APP_USER"
validate_system_name "SERVICE_NAME" "$SERVICE_NAME"
validate_system_name "WHATSAPP_PLUGIN_SERVICE_NAME" "$WHATSAPP_PLUGIN_SERVICE_NAME"
validate_port "DB_PORT" "$DB_PORT"
validate_port "BACKEND_PORT" "$BACKEND_PORT"
validate_port "WHATSAPP_PLUGIN_PORT" "$WHATSAPP_PLUGIN_PORT"
[[ "$DB_HOST" != *$'\n'* && "$DB_HOST" != *$'\r'* ]] || die "DB_HOST 不能包含换行"
[[ "$DB_PASSWORD" != *$'\n'* && "$DB_PASSWORD" != *$'\r'* ]] || die "数据库密码不能包含换行"
[[ -n "$DB_PASSWORD" ]] || die "数据库密码不能为空"
if is_true "$REPLACE_DATABASE"; then
  die "部署器不支持清空已有数据库。请保持 REPLACE_DATABASE=false，升级仅允许增量补齐结构"
fi
if is_true "$REMOVE_PRIMARY_ADMIN" && ! is_true "$PROVISION_BETA_ADMINS"; then
  die "REMOVE_PRIMARY_ADMIN=true 前必须启用 PROVISION_BETA_ADMINS=true"
fi

if [[ -z "$VHOST_FILE" ]]; then
  if [[ -f "$VHOST_DIR/$DOMAIN.conf" ]]; then
    VHOST_FILE="$VHOST_DIR/$DOMAIN.conf"
  elif [[ -f "$VHOST_DIR/proxy/$DOMAIN.conf" ]]; then
    VHOST_FILE="$VHOST_DIR/proxy/$DOMAIN.conf"
  elif [[ -d "$VHOST_DIR/proxy/$DOMAIN" ]]; then
    proxy_vhost_candidate="$(grep -RIl --include='*.conf' \
      -E "server_name[[:space:]]+([^;]*[[:space:]])?$DOMAIN([[:space:];]|$)" \
      "$VHOST_DIR/proxy/$DOMAIN" 2>/dev/null | sed -n '1p' || true)"
    VHOST_FILE="${proxy_vhost_candidate:-$VHOST_DIR/$DOMAIN.conf}"
  else
    VHOST_FILE="$VHOST_DIR/$DOMAIN.conf"
  fi
fi
WEB_ROOT="${WEB_ROOT:-/www/wwwroot/$DOMAIN}"
if [[ ! -f "$VHOST_FILE" ]]; then
  if ! is_true "$AUTO_CREATE_SITE"; then
    die "未找到宝塔网站配置 $VHOST_FILE，请启用 AUTO_CREATE_SITE=true 或手动创建网站"
  fi
  log "自动创建 Nginx 网站配置：$DOMAIN"
  install -d -m 0755 "$VHOST_DIR" "$WEB_ROOT"
  cat > "$VHOST_FILE" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    root $WEB_ROOT;
    index index.html index.htm;
}
EOF
  chmod 0644 "$VHOST_FILE"
  VHOST_CREATED=true
fi

log "1/9 检查宝塔站点、数据库和运行环境"
ensure_database
mysql_query -e "SELECT 1;" >/dev/null \
  || die "无法使用所填账号连接 MySQL"
database_engine_info="$(mysql_query -e "SELECT VERSION(), @@version_comment;" 2>/dev/null || true)"
if [[ -z "$database_engine_info" ]]; then
  die "无法读取数据库版本，请确认 DB_USER、DB_PASSWORD 和数据库服务状态"
fi
if [[ "$database_engine_info" =~ [Mm]ariaDB || ! "$database_engine_info" =~ ^8\. ]]; then
  die "当前数据库不受支持：$database_engine_info。GoodJob CRM 需要 MySQL 8.0+，请在宝塔切换数据库引擎后重试"
fi
database_exists="$(mysql_query -e "
  SELECT COUNT(*) FROM information_schema.schemata
  WHERE schema_name='${DB_NAME}';")"
[[ "$database_exists" == "1" ]] || die "数据库 $DB_NAME 不存在，请先在宝塔创建"

log "准备 WhatsApp PostgreSQL 数据库"
ensure_postgres_database

table_count="$(database_table_count)"
if (( table_count > 0 )); then
  if is_true "$REUSE_EXISTING_DATABASE"; then
    log "检测到已有数据库，将读取现有结构并增量补齐，不导出业务数据"
  else
    die "数据库不是空库。升级请设置 REUSE_EXISTING_DATABASE=true；部署器不会清空已有数据库"
  fi
fi

nginx_search_paths=("$VHOST_FILE")
if [[ -d "$VHOST_DIR/proxy/$DOMAIN" ]]; then
  nginx_search_paths+=("$VHOST_DIR/proxy/$DOMAIN")
fi
if grep -REq \
  'location[[:space:]]+(=|\^~)?[[:space:]]*/api(/|[[:space:]])' \
  "${nginx_search_paths[@]}" 2>/dev/null; then
  die "宝塔站点已经存在 /api 代理，请先移除旧代理后再安装"
fi
if grep -REq \
  'location[[:space:]]+(\^~[[:space:]]+)?/[[:space:]]*\{' \
  "${nginx_search_paths[@]}" 2>/dev/null; then
  die "宝塔站点已经存在根路径 location，无法自动接管，请先移除旧规则"
fi

website_root="$(awk '
  /^[[:space:]]*root[[:space:]]+[^;]+;/ {
    value=$2
    sub(/;$/, "", value)
    print value
    exit
  }
' "$VHOST_FILE")"
if [[ -n "$website_root" && -d "$website_root" ]] \
  && ! is_true "$ALLOW_NONEMPTY_WEB_ROOT"; then
  unexpected_web_file="$(find "$website_root" -mindepth 1 -maxdepth 1 \
    ! -name '.well-known' \
    ! -name '.user.ini' \
    ! -name '.htaccess' \
    ! -name '404.html' \
    ! -name '50x.html' \
    ! -name 'index.html' \
    -print -quit)"
  if [[ -n "$unexpected_web_file" ]]; then
    if ! confirm_action "网站目录已有内容，确认由 CRM 接管访问入口且不删除原文件吗？"; then
      die "网站目录非空。确认无误后设置 ALLOW_NONEMPTY_WEB_ROOT=true 再运行"
    fi
  fi
fi

log "2/9 创建受限运行用户和发布目录"
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system \
    --create-home \
    --home-dir "/var/lib/$APP_USER" \
    --shell /usr/sbin/nologin \
    "$APP_USER"
fi
install -d -m 0755 "$APP_ROOT" "$RELEASES_DIR"
install -d -o "$APP_USER" -g "$APP_USER" -m 0750 \
  "$SHARED_DIR" "$ROLLBACK_DIR" "$SHARED_DIR/puppeteer" "$SHARED_DIR/.wwebjs_auth"
install -d -o "$APP_USER" -g "$APP_USER" -m 0755 "$RELEASE_DIR"

if [[ -L "$CURRENT_LINK" ]]; then
  PREVIOUS_RELEASE="$(readlink -f "$CURRENT_LINK")"
elif [[ -e "$CURRENT_LINK" ]]; then
  die "$CURRENT_LINK 已存在且不是符号链接，请人工核对"
fi

log "3/9 复制发布文件并安装 Node.js 依赖"
rsync -a --delete \
  --exclude='.env' \
  --exclude='.git/' \
  --exclude='.svn/' \
  --exclude='node_modules/' \
  --exclude='whatsapp-plugin/.data/' \
  --exclude='whatsapp-plugin/dist/' \
  --exclude='whatsapp-plugin/dist-server/' \
  --exclude='.wwebjs_auth/' \
  --exclude='backups/' \
  --exclude='test-results/' \
  --exclude='playwright-report/' \
  --exclude='frontend/test-results/' \
  --exclude='deploy/baota/database/' \
  --exclude='database/' \
  "$SOURCE_DIR/" "$RELEASE_DIR/"
chown -R "$APP_USER:$APP_USER" "$RELEASE_DIR"
[[ -f "$RELEASE_DIR/package-lock.json" ]] || die "发布目录缺少根 package-lock.json"
[[ -f "$RELEASE_DIR/whatsapp-plugin/package-lock.json" ]] || die "发布目录缺少 Communication package-lock.json"

node_path="$(dirname "$NODE_BIN")"
runuser -u "$APP_USER" -- env \
  HOME="/var/lib/$APP_USER" \
  PATH="$node_path:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  PUPPETEER_CACHE_DIR="$SHARED_DIR/puppeteer" \
  "$NPM_BIN" --prefix "$RELEASE_DIR" ci --no-audit --no-fund

runuser -u "$APP_USER" -- env \
  HOME="/var/lib/$APP_USER" \
  PATH="$node_path:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  "$NPM_BIN" --prefix "$RELEASE_DIR/whatsapp-plugin" ci --no-audit --no-fund

if [[ -f "$RELEASE_DIR/backend/dist/server.js" \
  && -f "$RELEASE_DIR/frontend/dist/index.html" \
  && -f "$RELEASE_DIR/whatsapp-plugin/dist/index.html" \
  && -f "$RELEASE_DIR/whatsapp-plugin/dist-server/server/index.js" ]]; then
  log "4/9 使用安装包中的已构建生产产物"
elif [[ -d "$RELEASE_DIR/backend/src" && -d "$RELEASE_DIR/frontend/src" ]]; then
  log "4/9 执行生产构建"
  runuser -u "$APP_USER" -- env \
    HOME="/var/lib/$APP_USER" \
    PATH="$node_path:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    "$NPM_BIN" --prefix "$RELEASE_DIR" run build
  runuser -u "$APP_USER" -- env \
    HOME="/var/lib/$APP_USER" \
    PATH="$node_path:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    "$NPM_BIN" --prefix "$RELEASE_DIR/whatsapp-plugin" run build
else
  log "4/9 使用安装包中的已构建产物"
fi
[[ -f "$RELEASE_DIR/backend/dist/server.js" ]] || die "后端构建产物不存在"
[[ -f "$RELEASE_DIR/backend/dist/migrate-mysql.js" ]] || die "MySQL 增量迁移程序不存在"
[[ -f "$RELEASE_DIR/frontend/dist/index.html" ]] || die "前端构建产物不存在"
[[ -f "$RELEASE_DIR/whatsapp-plugin/dist/index.html" ]] || die "WhatsApp 插件前端构建产物不存在"
[[ -f "$RELEASE_DIR/whatsapp-plugin/dist-server/server/index.js" ]] || die "WhatsApp 插件后端构建产物不存在"

runuser -u "$APP_USER" -- env \
  HOME="/var/lib/$APP_USER" \
  PATH="$node_path:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  "$NPM_BIN" --prefix "$RELEASE_DIR" prune --omit=dev --no-audit --no-fund
runuser -u "$APP_USER" -- env \
  HOME="/var/lib/$APP_USER" \
  PATH="$node_path:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  "$NPM_BIN" --prefix "$RELEASE_DIR/whatsapp-plugin" prune --omit=dev --no-audit --no-fund
find "$RELEASE_DIR/frontend/dist" -type d -exec chmod 0755 {} +
find "$RELEASE_DIR/frontend/dist" -type f -exec chmod 0644 {} +
find "$RELEASE_DIR/whatsapp-plugin/dist" -type d -exec chmod 0755 {} +
find "$RELEASE_DIR/whatsapp-plugin/dist" -type f -exec chmod 0644 {} +

log "停止旧版本 CRM 与 Communication 服务"
stop_existing_services

log "5/9 初始化空库或增量核验现有数据库"
if (( table_count == 0 )); then
  gzip -dc "$BOOTSTRAP_FILE" | mysql_database_query

  users_count="$(mysql_database_query -e "SELECT COUNT(*) FROM users;")"
  admin_count="$(mysql_database_query -e "SELECT COUNT(*) FROM users WHERE role='admin';")"
  active_count="$(mysql_database_query -e "SELECT COUNT(*) FROM users WHERE status='active';")"
  team_count="$(mysql_database_query -e "SELECT COUNT(DISTINCT team_id) FROM users;")"
  invalid_count="$(mysql_database_query -e "
    SELECT COUNT(*) FROM users
    WHERE role<>'admin'
      OR status<>'active'
      OR team_id<>'europe'
      OR email<>'admin@goodjob.com';")"
  [[ "$users_count" == "1" \
    && "$admin_count" == "1" \
    && "$active_count" == "1" \
    && "$team_count" == "1" \
    && "$invalid_count" == "0" ]] \
    || die "数据库中的默认管理员校验失败"
fi

secret_values=()
for secret_name in \
  JWT_SECRET \
  PROVIDER_CREDENTIAL_KEY \
  AGENT_JOB_ENCRYPTION_KEY \
  TRADE_OBSERVATION_CURSOR_SECRET \
  MARKET_OPPORTUNITY_CURSOR_SECRET \
  PROSPECT_RUN_IDEMPOTENCY_SECRET \
  PROSPECT_RUN_CURSOR_SECRET \
  ORGANIZATION_IDENTITY_MASTER_SECRET \
  PROSPECT_SOURCE_RAW_ENVELOPE_SECRET \
  PROSPECT_COVERAGE_MASTER_SECRET \
  MYSQL_DATA_IMPORT_TOKEN; do
  ensure_secret "$secret_name"
  secret_value="${!secret_name}"
  (( ${#secret_value} >= 32 )) || die "$secret_name 长度不足"
  for existing_secret_value in "${secret_values[@]}"; do
    [[ "$secret_value" != "$existing_secret_value" ]] \
      || die "生产密钥必须彼此独立，发现重复值：$secret_name"
  done
  secret_values+=("$secret_value")
done
ensure_plugin_master_key
for existing_secret_value in "${secret_values[@]}"; do
  [[ "$WHATSAPP_PLUGIN_SESSION_MASTER_KEY" != "$existing_secret_value" ]] \
    || die "生产密钥必须彼此独立，WhatsApp 插件密钥与 CRM 密钥重复"
done

database_url="$(DB_APP_USER="$DB_USER" \
  DB_APP_PASSWORD="$DB_PASSWORD" \
  DB_APP_HOST="$DB_HOST" \
  DB_APP_PORT="$DB_PORT" \
  DB_APP_NAME="$DB_NAME" \
  "$NODE_BIN" -e '
    const url = new URL("mysql://placeholder/");
    url.username = process.env.DB_APP_USER;
    url.password = process.env.DB_APP_PASSWORD;
    url.hostname = process.env.DB_APP_HOST;
    url.port = process.env.DB_APP_PORT;
    url.pathname = `/${process.env.DB_APP_NAME}`;
    process.stdout.write(url.toString());
  ')"

log "读取 MySQL 现有结构并执行幂等增量迁移（不创建数据库备份）"
runuser -u "$APP_USER" -- env \
  HOME="/var/lib/$APP_USER" \
  PATH="$node_path:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  DATABASE_URL="$database_url" \
  GOODJOB_RELEASE_ID="$RELEASE_ID" \
  "$NODE_BIN" "$RELEASE_DIR/backend/dist/migrate-mysql.js"

whatsapp_database_url="$(DB_APP_USER="$WHATSAPP_DB_USER" \
  DB_APP_PASSWORD="$WHATSAPP_DB_PASSWORD" \
  DB_APP_HOST="$WHATSAPP_DB_HOST" \
  DB_APP_PORT="$WHATSAPP_DB_PORT" \
  DB_APP_NAME="$WHATSAPP_DB_NAME" \
  "$NODE_BIN" -e '
    const url = new URL("postgresql://placeholder/");
    url.username = process.env.DB_APP_USER;
    url.password = process.env.DB_APP_PASSWORD;
    url.hostname = process.env.DB_APP_HOST;
    url.port = process.env.DB_APP_PORT;
    url.pathname = `/${process.env.DB_APP_NAME}`;
    process.stdout.write(url.toString());
  ')"

https_active=false
if grep -Eq \
  '^[[:space:]]*(listen[[:space:]][^;]*443[^;]*ssl|ssl_certificate[[:space:]]+)' \
  "$VHOST_FILE"; then
  https_active=true
fi
if [[ "$https_active" == true ]]; then
  session_cookie_secure=true
  cors_origins="https://$DOMAIN"
else
  session_cookie_secure=false
  cors_origins="http://$DOMAIN,https://$DOMAIN"
  warn "当前宝塔站点未检测到 HTTPS。公测前请在宝塔启用 SSL，并按安装结果提示开启 Secure Cookie"
fi
if [[ -n "$EXTRA_ALLOWED_ORIGINS" ]]; then
  cors_origins="$cors_origins,$EXTRA_ALLOWED_ORIGINS"
fi

log "6/9 写入生产环境和 systemd 服务"
if [[ -f "$ENV_FILE" ]]; then
  ENV_FILE_EXISTED=true
  ENV_FILE_BACKUP="$ROLLBACK_DIR/env-before-${RELEASE_ID}"
  cp -p "$ENV_FILE" "$ENV_FILE_BACKUP"
fi
env_temp="$(mktemp "$SHARED_DIR/.env.XXXXXX")"
cat > "$env_temp" <<EOF
NODE_ENV=production
CRM_STORE=mysql
CRM_SEED_DEVELOPMENT_DATA=false
DATABASE_URL=$database_url
PORT=$BACKEND_PORT
BACKEND_HOST=127.0.0.1
WHATSAPP_PLUGIN_PORT=$WHATSAPP_PLUGIN_PORT
AGENT_RUNNER_POLL_MS=1000
OUTREACH_SEQUENCE_POLL_MS=5000
CUSTOMER_MAINTENANCE_POLL_MS=30000
AGENT_TRIGGER_POLL_MS=$AGENT_TRIGGER_POLL_MS
AGENT_MODEL_ROUTE_PLANNING=$AGENT_MODEL_ROUTE_PLANNING
AGENT_MODEL_ROUTE_EVALUATION=$AGENT_MODEL_ROUTE_EVALUATION
AGENT_DAILY_BUDGET_USD=$AGENT_DAILY_BUDGET_USD
AGENT_MISSION_BUDGET_USD=$AGENT_MISSION_BUDGET_USD
AGENT_INPUT_USD_PER_MILLION_TOKENS=$AGENT_INPUT_USD_PER_MILLION_TOKENS
AGENT_OUTPUT_USD_PER_MILLION_TOKENS=$AGENT_OUTPUT_USD_PER_MILLION_TOKENS
AGENT_KNOWLEDGE_DIR=$CURRENT_LINK/agent-knowledge
AGENT_SKILLS_DIR=$CURRENT_LINK/agent-skills
JWT_SECRET=$JWT_SECRET
PROVIDER_CREDENTIAL_KEY=$PROVIDER_CREDENTIAL_KEY
AGENT_JOB_ENCRYPTION_KEY=$AGENT_JOB_ENCRYPTION_KEY
TRADE_OBSERVATION_CURSOR_SECRET=$TRADE_OBSERVATION_CURSOR_SECRET
MARKET_OPPORTUNITY_CURSOR_SECRET=$MARKET_OPPORTUNITY_CURSOR_SECRET
PROSPECT_RUN_IDEMPOTENCY_SECRET=$PROSPECT_RUN_IDEMPOTENCY_SECRET
PROSPECT_RUN_CURSOR_SECRET=$PROSPECT_RUN_CURSOR_SECRET
ORGANIZATION_IDENTITY_MASTER_SECRET=$ORGANIZATION_IDENTITY_MASTER_SECRET
PROSPECT_SOURCE_RAW_ENVELOPE_SECRET=$PROSPECT_SOURCE_RAW_ENVELOPE_SECRET
PROSPECT_COVERAGE_MASTER_SECRET=$PROSPECT_COVERAGE_MASTER_SECRET
MYSQL_DATA_IMPORT_TOKEN=$MYSQL_DATA_IMPORT_TOKEN
MYSQL_LOCAL_BACKUP_ENABLED=$MYSQL_LOCAL_BACKUP_ENABLED
MYSQL_LOCAL_BACKUP_DIR=$MYSQL_LOCAL_BACKUP_DIR
MYSQL_LOCAL_BACKUP_RETENTION_DAYS=$MYSQL_LOCAL_BACKUP_RETENTION_DAYS
SESSION_COOKIE_SECURE=$session_cookie_secure
CORS_ORIGINS=$cors_origins
ENABLE_API_DOCS=$ENABLE_API_DOCS
EOF
chown "$APP_USER:$APP_USER" "$env_temp"
chmod 0600 "$env_temp"
mv -f "$env_temp" "$ENV_FILE"

if [[ -f "$WHATSAPP_PLUGIN_ENV_FILE" ]]; then
  WHATSAPP_PLUGIN_ENV_FILE_EXISTED=true
  WHATSAPP_PLUGIN_ENV_FILE_BACKUP="$ROLLBACK_DIR/whatsapp-plugin-env-before-${RELEASE_ID}"
  cp -p "$WHATSAPP_PLUGIN_ENV_FILE" "$WHATSAPP_PLUGIN_ENV_FILE_BACKUP"
fi
plugin_env_temp="$(mktemp "$SHARED_DIR/.whatsapp-plugin-env.XXXXXX")"
cat > "$plugin_env_temp" <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=$WHATSAPP_PLUGIN_PORT
WEB_ORIGIN=$([[ "$https_active" == true ]] && printf 'https://%s' "$DOMAIN" || printf 'http://%s' "$DOMAIN")
DATABASE_CLIENT=postgres
DATABASE_URL=$whatsapp_database_url
MEDIA_STORAGE_PATH=$SHARED_DIR/whatsapp-plugin/media
SESSION_MASTER_KEY=$WHATSAPP_PLUGIN_SESSION_MASTER_KEY
CRM_JWT_SECRET=$JWT_SECRET
SEED_DEMO=false
ALLOW_DEMO_PROVIDER=false
AUTO_MIGRATE=false
ALLOW_PRIVATE_AI_ENDPOINTS=false
EOF
install -d -o "$APP_USER" -g "$APP_USER" -m 0750 "$SHARED_DIR/whatsapp-plugin"
chown "$APP_USER:$APP_USER" "$plugin_env_temp"
chmod 0600 "$plugin_env_temp"
mv -f "$plugin_env_temp" "$WHATSAPP_PLUGIN_ENV_FILE"

set -a
# 迁移脚本读取插件环境文件，确保使用 shared 下的持久化 PostgreSQL 配置。
source "$WHATSAPP_PLUGIN_ENV_FILE"
set +a
runuser -u "$APP_USER" -- env \
  HOME="/var/lib/$APP_USER" \
  PATH="$node_path:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  "$NPM_BIN" --prefix "$RELEASE_DIR/whatsapp-plugin" run db:migrate

if [[ -f "$SERVICE_FILE" ]]; then
  SERVICE_FILE_EXISTED=true
  SERVICE_FILE_BACKUP="$ROLLBACK_DIR/systemd-before-${RELEASE_ID}.service"
  cp -p "$SERVICE_FILE" "$SERVICE_FILE_BACKUP"
fi
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=GoodJob CRM API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$SHARED_DIR
EnvironmentFile=$ENV_FILE
Environment=HOME=/var/lib/$APP_USER
Environment=PUPPETEER_CACHE_DIR=$SHARED_DIR/puppeteer
ExecStart=$NODE_BIN $CURRENT_LINK/backend/dist/server.js
Restart=on-failure
RestartSec=5
TimeoutStartSec=90
TimeoutStopSec=30
KillMode=mixed
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
LockPersonality=true
RestrictSUIDSGID=true
ReadWritePaths=$SHARED_DIR /var/lib/$APP_USER
UMask=0027
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "$SERVICE_FILE"

if [[ -f "$WHATSAPP_PLUGIN_SERVICE_FILE" ]]; then
  WHATSAPP_PLUGIN_SERVICE_FILE_EXISTED=true
  WHATSAPP_PLUGIN_SERVICE_FILE_BACKUP="$ROLLBACK_DIR/whatsapp-plugin-service-before-${RELEASE_ID}.service"
  cp -p "$WHATSAPP_PLUGIN_SERVICE_FILE" "$WHATSAPP_PLUGIN_SERVICE_FILE_BACKUP"
fi
cat > "$WHATSAPP_PLUGIN_SERVICE_FILE" <<EOF
[Unit]
Description=GoodJob CRM WhatsApp Plugin
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$CURRENT_LINK/whatsapp-plugin
EnvironmentFile=$WHATSAPP_PLUGIN_ENV_FILE
Environment=HOME=/var/lib/$APP_USER
ExecStart=$NODE_BIN $CURRENT_LINK/whatsapp-plugin/dist-server/server/index.js
Restart=on-failure
RestartSec=5
TimeoutStartSec=120
TimeoutStopSec=30
KillMode=mixed
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
LockPersonality=true
RestrictSUIDSGID=true
ReadWritePaths=$SHARED_DIR/whatsapp-plugin /var/lib/$APP_USER
UMask=0027
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "$WHATSAPP_PLUGIN_SERVICE_FILE"

log "7/9 接入宝塔 Nginx，不覆盖现有 SSL 配置"
install -d -m 0755 "$NGINX_MANAGED_DIR"
NGINX_INCLUDE_FILE="$NGINX_MANAGED_DIR/$DOMAIN.conf"
if [[ -f "$NGINX_INCLUDE_FILE" ]]; then
  NGINX_INCLUDE_EXISTED=true
  NGINX_INCLUDE_BACKUP="$ROLLBACK_DIR/nginx-include-before-${RELEASE_ID}.conf"
  cp -p "$NGINX_INCLUDE_FILE" "$NGINX_INCLUDE_BACKUP"
fi
cat > "$NGINX_INCLUDE_FILE" <<EOF
# Managed by GoodJob CRM installer.
location ^~ /whatsapp-plugin/api/ {
    proxy_pass http://127.0.0.1:$WHATSAPP_PLUGIN_PORT/api/;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Cookie \$http_cookie;
    proxy_connect_timeout 10s;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    proxy_buffering off;
}

location ^~ /whatsapp-plugin/socket.io {
    proxy_pass http://127.0.0.1:$WHATSAPP_PLUGIN_PORT/socket.io;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Cookie \$http_cookie;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    proxy_buffering off;
}

location = /whatsapp-plugin {
    return 302 /whatsapp-plugin/\$is_args\$args;
}

location = /whatsapp-plugin/ {
    return 302 /whatsapp-plugin/index.html\$is_args\$args;
}

location = /whatsapp-plugin/index.html {
    alias $CURRENT_LINK/whatsapp-plugin/dist/index.html;
    default_type text/html;
    add_header Cache-Control "no-store";
}

location ^~ /whatsapp-plugin/assets/ {
    alias $CURRENT_LINK/whatsapp-plugin/dist/assets/;
    expires 7d;
    add_header Cache-Control "public, immutable";
}

location = /api {
    proxy_pass http://127.0.0.1:$BACKEND_PORT/api;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_connect_timeout 10s;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    proxy_buffering off;
}

location ^~ /api/ {
    proxy_pass http://127.0.0.1:$BACKEND_PORT;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_connect_timeout 10s;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    proxy_buffering off;
}

location ^~ /assets/ {
    root $CURRENT_LINK/frontend/dist;
    try_files \$uri =404;
    expires 7d;
    add_header Cache-Control "public, immutable";
}

location ^~ / {
    root $CURRENT_LINK/frontend/dist;
    try_files \$uri \$uri/ /index.html;
    add_header Cache-Control "no-store";
}
EOF
chmod 0644 "$NGINX_INCLUDE_FILE"

include_line="    include $NGINX_INCLUDE_FILE;"
if ! grep -Fq "include $NGINX_INCLUDE_FILE;" "$VHOST_FILE"; then
  VHOST_BACKUP="$ROLLBACK_DIR/vhost-before-${RELEASE_ID}.conf"
  cp -p "$VHOST_FILE" "$VHOST_BACKUP"
  vhost_temp="$(mktemp "$VHOST_DIR/.${DOMAIN}.conf.XXXXXX")"
  awk -v include_line="$include_line" '
    function brace_delta(line, copy, opens, closes) {
      copy=line
      opens=gsub(/\{/, "{", copy)
      copy=line
      closes=gsub(/\}/, "}", copy)
      return opens-closes
    }
    {
      line=$0
      if (!in_server && line ~ /^[[:space:]]*server[[:space:]]*\{/) {
        in_server=1
        depth=brace_delta(line)
        print line
        next
      }
      if (in_server) {
        delta=brace_delta(line)
        if (depth+delta == 0 && line ~ /^[[:space:]]*}[[:space:]]*$/) {
          print include_line
          print line
          in_server=0
          depth=0
          next
        }
        depth+=delta
      }
      print line
    }
    END {
      if (in_server) exit 42
    }
  ' "$VHOST_FILE" > "$vhost_temp"
  mv -f "$vhost_temp" "$VHOST_FILE"
  grep -Fq "include $NGINX_INCLUDE_FILE;" "$VHOST_FILE" \
    || die "无法把 CRM 配置接入宝塔 Nginx server 块"
  VHOST_CHANGED=true
fi

ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
CURRENT_SWITCHED=true
"$NGINX_BIN" -t

if is_true "$PROVISION_BETA_ADMINS"; then
  log "恢复并核验 40 个公测团队管理员"
  runuser -u "$APP_USER" -- env \
    HOME="/var/lib/$APP_USER" \
    PATH="$(dirname "$NODE_BIN"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    DATABASE_URL="$database_url" \
    BETA_ADMIN_CREDENTIALS_FILE="$BETA_ADMIN_CREDENTIALS_FILE" \
    REMOVE_PRIMARY_ADMIN="$REMOVE_PRIMARY_ADMIN" \
    "$NODE_BIN" "$CURRENT_LINK/backend/dist/provision-beta-admins.js"
  chmod 0600 "$BETA_ADMIN_CREDENTIALS_FILE"
  chown "$APP_USER:$APP_USER" "$BETA_ADMIN_CREDENTIALS_FILE"
  beta_admin_count="$(mysql_database_query -e "
    SELECT COUNT(*) FROM users
    WHERE role='admin'
      AND status='active'
      AND email REGEXP '^beta-admin-[0-9]{2}@goodjob-crm[.]com$'
      AND team_id REGEXP '^beta-[0-9]{3}$';")"
  beta_team_count="$(mysql_database_query -e "
    SELECT COUNT(DISTINCT team_id) FROM users
    WHERE role='admin'
      AND status='active'
      AND email REGEXP '^beta-admin-[0-9]{2}@goodjob-crm[.]com$';")"
  [[ "$beta_admin_count" == "40" && "$beta_team_count" == "40" ]] \
    || die "40 个公测团队管理员部署后核验失败"
  if is_true "$REMOVE_PRIMARY_ADMIN"; then
    primary_admin_count="$(mysql_database_query -e "
      SELECT COUNT(*) FROM users
      WHERE id='u_admin' OR email='admin@goodjob.com';")"
    [[ "$primary_admin_count" == "0" ]] || die "旧通用管理员删除失败"
  fi
fi

log "8/9 启动服务并执行后端、代理健康检查"
systemctl daemon-reload
systemd-analyze verify "$SERVICE_FILE"
systemd-analyze verify "$WHATSAPP_PLUGIN_SERVICE_FILE"
systemctl enable "$SERVICE_NAME"
systemctl enable "$WHATSAPP_PLUGIN_SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
systemctl restart "$WHATSAPP_PLUGIN_SERVICE_NAME"
wait_for_backend_health || die "后端在 80 秒内未通过 MySQL 健康检查"
wait_for_plugin_health || die "WhatsApp 插件在 80 秒内未通过健康检查"
reload_nginx
# 宝塔 Nginx reload 为异步操作，等待新 worker 接管后再做代理健康检查。
sleep 8
nginx_runtime_config_file="$(mktemp)"
"$NGINX_BIN" -T > "$nginx_runtime_config_file" 2>&1 || true
grep -Fq "$NGINX_INCLUDE_FILE" "$nginx_runtime_config_file" \
  || die "宝塔 Nginx 未加载 CRM 配置：$NGINX_INCLUDE_FILE。请确认域名站点已接入宝塔 Nginx"
rm -f "$nginx_runtime_config_file"

if [[ "$https_active" == true ]]; then
  proxy_response="$(curl -kfsS --resolve "$DOMAIN:443:127.0.0.1" \
    "https://$DOMAIN/api/health")"
else
  proxy_response="$(curl -fsS -H "Host: $DOMAIN" \
    "http://127.0.0.1/api/health")"
fi
printf '%s' "$proxy_response" \
  | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' \
  || die "宝塔 Nginx 反向代理健康检查失败"

log "9/9 清理旧版本并完成安装"
CURRENT_SWITCHED=false
INSTALL_SUCCEEDED=true
find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
  | sort -nr \
  | awk 'NR > 3 {sub(/^[^ ]+ /, ""); print}' \
  | while IFS= read -r old_release; do
      [[ -n "$old_release" && "$old_release" != "$PREVIOUS_RELEASE" ]] \
        && rm -rf -- "$old_release"
    done
find "$ROLLBACK_DIR" -type f -mtime +30 -delete

printf '\n\033[1;32mGoodJob CRM 宝塔安装完成。\033[0m\n'
printf '访问地址：%s://%s\n' \
  "$([[ "$https_active" == true ]] && printf https || printf http)" \
  "$DOMAIN"
printf 'Swagger：%s://%s/api/docs/\n' \
  "$([[ "$https_active" == true ]] && printf https || printf http)" \
  "$DOMAIN"
printf '服务状态：systemctl status %s\n' "$SERVICE_NAME"
printf '实时日志：journalctl -u %s -f\n' "$SERVICE_NAME"
printf 'WhatsApp 服务状态：systemctl status %s\n' "$WHATSAPP_PLUGIN_SERVICE_NAME"
printf 'WhatsApp 日志：journalctl -u %s -f\n' "$WHATSAPP_PLUGIN_SERVICE_NAME"
printf '运行环境：%s（权限 600）\n' "$ENV_FILE"
printf 'WhatsApp 运行环境：%s（权限 600）\n' "$WHATSAPP_PLUGIN_ENV_FILE"
printf '配置回滚目录（不含数据库数据）：%s\n' "$ROLLBACK_DIR"
printf '当前版本：%s\n' "$RELEASE_DIR"
printf '公测管理员凭据：%s（权限 600）\n' "$BETA_ADMIN_CREDENTIALS_FILE"

if [[ "$https_active" == false ]]; then
  cat <<EOF

公测前必须完成：
  1. 在宝塔网站设置中申请并开启 SSL。
  2. 执行：
     sed -i 's/^SESSION_COOKIE_SECURE=false$/SESSION_COOKIE_SECURE=true/' '$ENV_FILE'
     systemctl restart '$SERVICE_NAME'
  3. 使用 https://$DOMAIN 登录并复测。
EOF
fi
