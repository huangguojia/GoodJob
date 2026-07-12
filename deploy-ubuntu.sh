#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="${SOURCE_DIR:-$SCRIPT_DIR}"
APP_ROOT="${APP_ROOT:-/opt/goodjob-crm}"
APP_USER="${APP_USER:-goodjob-crm}"
SERVICE_NAME="${SERVICE_NAME:-goodjob-crm}"
DB_NAME="${DB_NAME:-goodjob_crm}"
DB_USER="${DB_USER:-goodjob}"
DB_PASSWORD="${DB_PASSWORD:-}"
JWT_SECRET="${JWT_SECRET:-}"
INITIAL_ADMIN_EMAIL="${INITIAL_ADMIN_EMAIL:-admin@example.com}"
INITIAL_ADMIN_PASSWORD="${INITIAL_ADMIN_PASSWORD:-}"
INITIAL_ADMIN_NAME="${INITIAL_ADMIN_NAME:-Super Admin}"
BACKEND_PORT="${BACKEND_PORT:-4188}"
DOMAIN_EXPLICIT="${DOMAIN+x}"
ENABLE_HTTPS_EXPLICIT="${ENABLE_HTTPS+x}"
LETSENCRYPT_EMAIL_EXPLICIT="${LETSENCRYPT_EMAIL+x}"
DOMAIN="${DOMAIN:-}"
ENABLE_HTTPS="${ENABLE_HTTPS:-}"
LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:-}"
NON_INTERACTIVE="${NON_INTERACTIVE:-false}"
DRY_RUN=false
RELEASE_ID="$(date +%Y%m%d%H%M%S)"
RELEASES_DIR="$APP_ROOT/releases"
SHARED_DIR="$APP_ROOT/shared"
CURRENT_LINK="$APP_ROOT/current"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
ENV_FILE="$SHARED_DIR/.env"
BACKUP_DIR="$SHARED_DIR/backups"
DEPLOY_CONFIG="$APP_ROOT/deploy.conf"
PREVIOUS_RELEASE=""
SWITCHED_RELEASE=false
DB_PASSWORD_WAS_GENERATED=false

readonly SCRIPT_DIR SOURCE_DIR APP_ROOT APP_USER SERVICE_NAME DB_NAME DB_USER BACKEND_PORT
readonly RELEASE_ID RELEASES_DIR SHARED_DIR CURRENT_LINK RELEASE_DIR ENV_FILE BACKUP_DIR DEPLOY_CONFIG

log() {
  printf '\n\033[1;34m[%s]\033[0m %s\n' "$(date '+%H:%M:%S')" "$*"
}

warn() {
  printf '\033[1;33m警告：%s\033[0m\n' "$*" >&2
}

die() {
  printf '\033[1;31m错误：%s\033[0m\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
GoodJob CRM Ubuntu 无 Docker 一键部署脚本

用法：
  sudo bash deploy-ubuntu.sh
  bash deploy-ubuntu.sh --dry-run
  bash deploy-ubuntu.sh --help

常用环境变量：
  SOURCE_DIR           源码目录，默认是脚本所在目录
  APP_ROOT             部署根目录，默认 /opt/goodjob-crm
  DOMAIN               域名；留空时使用服务器 IP
  ENABLE_HTTPS         true/false，默认 false
  LETSENCRYPT_EMAIL    申请 HTTPS 证书使用的邮箱
  DB_NAME              数据库名，默认 goodjob_crm
  DB_USER              数据库用户，默认 goodjob
  DB_PASSWORD          数据库密码；首次部署留空会自动生成
  JWT_SECRET           会话签名密钥；留空自动生成并持久化
  INITIAL_ADMIN_EMAIL  首次空库部署的超级管理员邮箱
  INITIAL_ADMIN_PASSWORD 首次空库部署的超级管理员密码，至少 12 位
  BACKEND_PORT         后端监听端口，默认 4188
  NON_INTERACTIVE      true/false；true 时不询问，适合自动部署

无人值守示例：
  sudo env NON_INTERACTIVE=true DOMAIN=crm.example.com \
    ENABLE_HTTPS=true LETSENCRYPT_EMAIL=ops@example.com \
    DB_PASSWORD='replace-with-a-strong-password' \
    bash deploy-ubuntu.sh

说明：
  - 重复执行会发布新版本，不会清空数据库。
  - 更新前会自动备份已有 MySQL 数据。
  - 新版本健康检查失败时会自动回滚到上一版本。
EOF
}

is_true() {
  case "$1" in
    1|true|TRUE|True|yes|YES|Yes|y|Y|on|ON|On) return 0 ;;
    *) return 1 ;;
  esac
}

prompt_value() {
  local variable_name="$1"
  local prompt_text="$2"
  local default_value="$3"
  local secret="${4:-false}"
  local current_value="${!variable_name:-}"
  local answer=""

  if [[ -n "$current_value" ]] || is_true "$NON_INTERACTIVE"; then
    return
  fi

  if is_true "$secret"; then
    read -r -s -p "$prompt_text（留空自动生成）: " answer
    printf '\n'
  else
    read -r -p "$prompt_text [$default_value]: " answer
  fi
  printf -v "$variable_name" '%s' "${answer:-$default_value}"
}

validate_identifier() {
  local label="$1"
  local value="$2"
  [[ "$value" =~ ^[A-Za-z0-9_]+$ ]] || die "$label 只能包含英文字母、数字和下划线：$value"
}

validate_system_name() {
  local label="$1"
  local value="$2"
  [[ "$value" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] \
    || die "$label 只能包含英文字母、数字、下划线和连字符，且不能以数字开头：$value"
}

validate_port() {
  [[ "$BACKEND_PORT" =~ ^[0-9]+$ ]] || die "BACKEND_PORT 必须是数字"
  (( BACKEND_PORT >= 1024 && BACKEND_PORT <= 65535 )) || die "BACKEND_PORT 必须在 1024-65535 之间"
}

validate_domain() {
  [[ -z "$DOMAIN" ]] && return
  [[ "$DOMAIN" != http://* && "$DOMAIN" != https://* && "$DOMAIN" != */* ]] \
    || die "DOMAIN 只填写域名，不要包含 http、https 或路径"
  [[ "$DOMAIN" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]] \
    || die "域名格式不正确：$DOMAIN"
}

generate_password() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  else
    od -An -N24 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

sql_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\'/\'\'}"
  printf '%s' "$value"
}

url_encode() {
  python3 - "$1" <<'PY'
import sys
from urllib.parse import quote
print(quote(sys.argv[1], safe=""))
PY
}

read_existing_env_value() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 0
  sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n 1
}

read_deploy_config_value() {
  local key="$1"
  [[ -f "$DEPLOY_CONFIG" ]] || return 0
  awk -F= -v wanted="$key" '$1 == wanted {sub(/^[^=]*=/, ""); print; exit}' "$DEPLOY_CONFIG"
}

on_error() {
  local exit_code=$?
  local line_number="${BASH_LINENO[0]:-unknown}"
  printf '\n\033[1;31m部署在第 %s 行失败，退出码 %s。\033[0m\n' "$line_number" "$exit_code" >&2

  if [[ "$SWITCHED_RELEASE" == true && -n "$PREVIOUS_RELEASE" && -d "$PREVIOUS_RELEASE" ]]; then
    warn "正在切回上一版本：$PREVIOUS_RELEASE"
    ln -sfn "$PREVIOUS_RELEASE" "$CURRENT_LINK"
    systemctl restart "$SERVICE_NAME" >/dev/null 2>&1 || true
  elif [[ "$SWITCHED_RELEASE" == true ]]; then
    warn "首次发布失败，正在停用未通过检查的版本"
    systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true
    rm -f "$CURRENT_LINK"
  fi

  if command -v systemctl >/dev/null 2>&1; then
    printf '\n最近的服务日志：\n' >&2
    journalctl -u "$SERVICE_NAME" -n 60 --no-pager >&2 || true
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
    --dry-run)
      DRY_RUN=true
      ;;
    *)
      die "未知参数：$argument"
      ;;
  esac
done

if [[ "$DRY_RUN" == true ]]; then
  NON_INTERACTIVE=true
fi

if [[ -f "$DEPLOY_CONFIG" ]]; then
  [[ -n "$DOMAIN_EXPLICIT" ]] || DOMAIN="$(read_deploy_config_value DOMAIN)"
  [[ -n "$ENABLE_HTTPS_EXPLICIT" ]] || ENABLE_HTTPS="$(read_deploy_config_value ENABLE_HTTPS)"
  [[ -n "$LETSENCRYPT_EMAIL_EXPLICIT" ]] || LETSENCRYPT_EMAIL="$(read_deploy_config_value LETSENCRYPT_EMAIL)"
fi

if [[ -z "$DB_PASSWORD" && -f "$ENV_FILE" ]]; then
  existing_database_url="$(read_existing_env_value DATABASE_URL)"
  if [[ "$existing_database_url" =~ ^mysql://[^:]+:([^@]+)@ ]]; then
    encoded_existing_password="${BASH_REMATCH[1]}"
    DB_PASSWORD="$(python3 - "$encoded_existing_password" <<'PY'
import sys
from urllib.parse import unquote
print(unquote(sys.argv[1]))
PY
)"
  fi
fi
if [[ -f "$ENV_FILE" ]]; then
  [[ -n "$JWT_SECRET" ]] || JWT_SECRET="$(read_existing_env_value JWT_SECRET)"
  [[ -n "$INITIAL_ADMIN_EMAIL" ]] || INITIAL_ADMIN_EMAIL="$(read_existing_env_value INITIAL_ADMIN_EMAIL)"
  [[ -n "$INITIAL_ADMIN_PASSWORD" ]] || INITIAL_ADMIN_PASSWORD="$(read_existing_env_value INITIAL_ADMIN_PASSWORD)"
fi

prompt_value DOMAIN "请输入访问域名，没有域名可直接回车" ""
if [[ -z "$DOMAIN" ]]; then
  ENABLE_HTTPS=false
elif [[ -z "$ENABLE_HTTPS" && "$DRY_RUN" == false ]] && ! is_true "$NON_INTERACTIVE"; then
  read -r -p "是否自动申请并启用 HTTPS？[y/N]: " https_answer
  ENABLE_HTTPS="${https_answer:-false}"
else
  ENABLE_HTTPS="${ENABLE_HTTPS:-false}"
fi
if is_true "$ENABLE_HTTPS"; then
  prompt_value LETSENCRYPT_EMAIL "请输入申请 HTTPS 证书的邮箱" ""
fi
prompt_value DB_PASSWORD "请输入 MySQL 业务账号密码" "" true
prompt_value INITIAL_ADMIN_EMAIL "请输入首次部署超级管理员邮箱" "admin@example.com"
prompt_value INITIAL_ADMIN_PASSWORD "请输入首次部署超级管理员密码" "" true

if [[ -z "$DB_PASSWORD" ]]; then
  DB_PASSWORD="$(generate_password)"
  DB_PASSWORD_WAS_GENERATED=true
fi
[[ -n "$JWT_SECRET" ]] || JWT_SECRET="$(generate_password)"
[[ -n "$INITIAL_ADMIN_PASSWORD" ]] || INITIAL_ADMIN_PASSWORD="$(generate_password)"

validate_identifier "DB_NAME" "$DB_NAME"
validate_identifier "DB_USER" "$DB_USER"
validate_system_name "APP_USER" "$APP_USER"
validate_system_name "SERVICE_NAME" "$SERVICE_NAME"
validate_port
validate_domain
[[ "$DB_PASSWORD" != *$'\n'* && "$DB_PASSWORD" != *$'\r'* ]] || die "数据库密码不能包含换行符"
[[ "$INITIAL_ADMIN_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || die "首次管理员邮箱格式不正确"
(( ${#INITIAL_ADMIN_PASSWORD} >= 12 )) || die "首次管理员密码至少需要 12 位"
(( ${#JWT_SECRET} >= 32 )) || die "JWT_SECRET 至少需要 32 位"

for required_file in package.json package-lock.json backend/package.json frontend/package.json backend/src/server.ts; do
  [[ -f "$SOURCE_DIR/$required_file" ]] || die "源码目录缺少 $required_file：$SOURCE_DIR"
done

if [[ "$DRY_RUN" == true ]]; then
  cat <<EOF

配置检查通过（dry-run，不会修改系统）：
  源码目录：$SOURCE_DIR
  部署目录：$APP_ROOT
  服务名称：$SERVICE_NAME
  运行用户：$APP_USER
  数据库：$DB_NAME
  数据库用户：$DB_USER
  后端端口：$BACKEND_PORT
  域名：${DOMAIN:-未设置，将使用服务器 IP}
  HTTPS：$ENABLE_HTTPS

实际执行命令：
  sudo bash "$SCRIPT_DIR/$(basename -- "${BASH_SOURCE[0]}")"
EOF
  exit 0
fi

[[ "$(id -u)" -eq 0 ]] || die "请使用 sudo bash $0 运行"
[[ -f /etc/os-release ]] || die "无法识别操作系统"
# shellcheck disable=SC1091
source /etc/os-release
[[ "${ID:-}" == "ubuntu" ]] || die "此脚本仅支持 Ubuntu，当前系统是 ${PRETTY_NAME:-未知}"

log "1/9 安装系统依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg nginx mysql-server rsync python3

node_major=0
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0')"
fi
if (( node_major < 20 )); then
  log "安装 Node.js 20"
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  printf '%s\n' "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update
  apt-get install -y nodejs
fi
node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
(( node_major >= 20 )) || die "Node.js 安装失败，需要 20 或更高版本"

log "2/9 准备运行用户和发布目录"
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/var/lib/$APP_USER" --shell /usr/sbin/nologin "$APP_USER"
fi
install -d -m 0755 "$APP_ROOT" "$RELEASES_DIR"
install -d -o "$APP_USER" -g "$APP_USER" -m 0750 "$SHARED_DIR" "$BACKUP_DIR"
cat > "$DEPLOY_CONFIG" <<EOF
DOMAIN=$DOMAIN
ENABLE_HTTPS=$ENABLE_HTTPS
LETSENCRYPT_EMAIL=$LETSENCRYPT_EMAIL
EOF
chown root:root "$DEPLOY_CONFIG"
chmod 0600 "$DEPLOY_CONFIG"

log "3/9 启动 MySQL 并创建业务数据库"
systemctl enable --now mysql
escaped_password="$(sql_escape "$DB_PASSWORD")"
mysql --protocol=socket -uroot <<SQL
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$escaped_password';
ALTER USER '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$escaped_password';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX
  ON \`$DB_NAME\`.* TO '$DB_USER'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL

table_count="$(mysql --protocol=socket -N -B -uroot -e \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DB_NAME';")"
if (( table_count > 0 )); then
  backup_file="$BACKUP_DIR/${DB_NAME}_${RELEASE_ID}.sql.gz"
  log "备份现有数据库到 $backup_file"
  MYSQL_PWD="$DB_PASSWORD" mysqldump --single-transaction --quick --no-tablespaces \
    -h 127.0.0.1 -u "$DB_USER" "$DB_NAME" | gzip -9 > "$backup_file"
  chown "$APP_USER:$APP_USER" "$backup_file"
  chmod 0640 "$backup_file"
fi

log "4/9 复制源码并安装依赖"
install -d -o "$APP_USER" -g "$APP_USER" -m 0755 "$RELEASE_DIR"
rsync -a --delete \
  --exclude='.git/' \
  --exclude='.env' \
  --exclude='node_modules/' \
  --exclude='backend/dist/' \
  --exclude='frontend/dist/' \
  --exclude='playwright-report/' \
  --exclude='test-results/' \
  "$SOURCE_DIR/" "$RELEASE_DIR/"
chown -R "$APP_USER:$APP_USER" "$RELEASE_DIR"

runuser -u "$APP_USER" -- env HOME="/var/lib/$APP_USER" \
  npm ci --no-audit --no-fund --prefix "$RELEASE_DIR"

log "5/9 构建后端和前端"
runuser -u "$APP_USER" -- env HOME="/var/lib/$APP_USER" \
  npm run build --prefix "$RELEASE_DIR"
[[ -f "$RELEASE_DIR/backend/dist/server.js" ]] || die "后端构建产物不存在"
[[ -f "$RELEASE_DIR/frontend/dist/index.html" ]] || die "前端构建产物不存在"

encoded_password="$(url_encode "$DB_PASSWORD")"
cat > "$ENV_FILE" <<EOF
NODE_ENV=production
CRM_STORE=mysql
DATABASE_URL=mysql://$DB_USER:$encoded_password@127.0.0.1:3306/$DB_NAME
PORT=$BACKEND_PORT
JWT_SECRET=$JWT_SECRET
INITIAL_ADMIN_EMAIL=$INITIAL_ADMIN_EMAIL
INITIAL_ADMIN_PASSWORD=$INITIAL_ADMIN_PASSWORD
INITIAL_ADMIN_NAME=$INITIAL_ADMIN_NAME
SESSION_COOKIE_SECURE=$([[ -n "$DOMAIN" ]] && is_true "$ENABLE_HTTPS" && printf true || printf false)
CORS_ORIGINS=$([[ -n "$DOMAIN" ]] && printf 'https://%s,http://%s' "$DOMAIN" "$DOMAIN")
EOF
chown "$APP_USER:$APP_USER" "$ENV_FILE"
chmod 0600 "$ENV_FILE"
ln -sfn "$ENV_FILE" "$RELEASE_DIR/.env"

log "6/9 配置 systemd 服务"
cat > "/etc/systemd/system/$SERVICE_NAME.service" <<EOF
[Unit]
Description=GoodJob CRM API
After=network-online.target mysql.service
Wants=network-online.target
Requires=mysql.service

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$CURRENT_LINK
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node $CURRENT_LINK/backend/dist/server.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ReadWritePaths=$SHARED_DIR /var/lib/$APP_USER
UMask=0027

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"

log "7/9 配置 Nginx"
server_name="${DOMAIN:-_}"
cat > "/etc/nginx/sites-available/$SERVICE_NAME" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $server_name;

    root $CURRENT_LINK/frontend/dist;
    index index.html;
    client_max_body_size 20m;
    server_tokens off;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
    add_header X-Frame-Options "DENY" always;

    location /api/ {
        proxy_pass http://127.0.0.1:$BACKEND_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_connect_timeout 10s;
        proxy_read_timeout 120s;
    }

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    location ~ /\. {
        deny all;
    }
}
EOF
ln -sfn "/etc/nginx/sites-available/$SERVICE_NAME" "/etc/nginx/sites-enabled/$SERVICE_NAME"
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable --now nginx

log "8/9 切换版本并执行健康检查"
[[ ! -e "$CURRENT_LINK" || -L "$CURRENT_LINK" ]] \
  || die "$CURRENT_LINK 已存在且不是符号链接，请先人工核对该目录"
if [[ -L "$CURRENT_LINK" ]]; then
  PREVIOUS_RELEASE="$(readlink -f "$CURRENT_LINK")"
fi
ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
SWITCHED_RELEASE=true
systemd-analyze verify "/etc/systemd/system/$SERVICE_NAME.service"
systemctl restart "$SERVICE_NAME"
systemctl reload nginx

healthy=false
for _ in {1..30}; do
  if curl -fsS "http://127.0.0.1:$BACKEND_PORT/api/health" \
    | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true.*"store"[[:space:]]*:[[:space:]]*"mysql"'; then
    healthy=true
    break
  fi
  sleep 2
done
[[ "$healthy" == true ]] || die "后端在 60 秒内未通过健康检查"
SWITCHED_RELEASE=false

if [[ -n "$DOMAIN" ]]; then
  curl -fsS -H "Host: $DOMAIN" "http://127.0.0.1/api/health" \
    | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' \
    || die "Nginx 反向代理健康检查失败"
else
  curl -fsS "http://127.0.0.1/api/health" \
    | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' \
    || die "Nginx 反向代理健康检查失败"
fi

log "9/9 清理旧版本并按需配置 HTTPS"
find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
  | sort -nr \
  | awk 'NR > 3 {sub(/^[^ ]+ /, ""); print}' \
  | while IFS= read -r old_release; do
      [[ -n "$old_release" && "$old_release" != "$PREVIOUS_RELEASE" ]] && rm -rf -- "$old_release"
    done
find "$BACKUP_DIR" -type f -name "${DB_NAME}_*.sql.gz" -mtime +30 -delete

if is_true "$ENABLE_HTTPS"; then
  [[ -n "$DOMAIN" ]] || die "启用 HTTPS 时必须设置 DOMAIN"
  [[ -n "$LETSENCRYPT_EMAIL" ]] || die "启用 HTTPS 时必须设置 LETSENCRYPT_EMAIL"
  getent ahosts "$DOMAIN" >/dev/null 2>&1 \
    || die "域名 $DOMAIN 尚无可用 DNS 解析，暂时不能申请 HTTPS 证书"
  apt-get install -y certbot python3-certbot-nginx
  certbot --nginx --non-interactive --agree-tos --redirect \
    --email "$LETSENCRYPT_EMAIL" -d "$DOMAIN"
  systemctl enable --now certbot.timer
fi

access_url="http://${DOMAIN:-$(hostname -I | awk '{print $1}')}"
if is_true "$ENABLE_HTTPS"; then
  access_url="https://$DOMAIN"
fi

printf '\n\033[1;32mGoodJob CRM 部署成功。\033[0m\n'
printf '访问地址：%s\n' "$access_url"
printf '服务状态：systemctl status %s\n' "$SERVICE_NAME"
printf '实时日志：journalctl -u %s -f\n' "$SERVICE_NAME"
printf '当前版本：%s\n' "$RELEASE_DIR"
printf '数据库备份：%s\n' "$BACKUP_DIR"

if [[ "$DB_PASSWORD_WAS_GENERATED" == true ]]; then
  printf '\n首次部署已自动生成数据库密码，请立即妥善保存：\n'
  printf '  数据库：%s\n  用户：%s\n  密码：%s\n' "$DB_NAME" "$DB_USER" "$DB_PASSWORD"
else
  printf '\n数据库凭据已写入受限环境文件：%s\n' "$ENV_FILE"
fi
