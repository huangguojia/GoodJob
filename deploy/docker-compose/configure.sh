#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

[[ "${EUID:-$(id -u)}" -eq 0 ]] || die "请使用 root 执行"
require_command openssl

if [[ -e "$APP_ROOT" ]]; then
  die "$APP_ROOT 已存在。为避免占用其他服务目录，首次配置要求该路径不存在"
fi
if [[ -e "$ENV_FILE" || -d "$SECRETS_DIR" ]]; then
  die "$SHARED_DIR 已有配置。为避免覆盖现有生产凭据，本脚本拒绝重复配置"
fi

read -r -p "GoodJob 专属域名（不含 http/https）：" DOMAIN
DOMAIN="${DOMAIN,,}"
[[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] \
  || die "域名格式不正确"

read -r -p "当前是否已经启用 HTTPS？[y/N]：" HTTPS_REPLY
if [[ "$HTTPS_REPLY" =~ ^[Yy]$ ]]; then
  PUBLIC_SCHEME=https
  SESSION_COOKIE_SECURE=true
else
  PUBLIC_SCHEME=http
  SESSION_COOKIE_SECURE=false
fi

read -r -p "首次超级管理员邮箱：" INITIAL_ADMIN_EMAIL
[[ "$INITIAL_ADMIN_EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$ ]] \
  || die "管理员邮箱格式不正确"
read -r -p "首次超级管理员姓名 [Super Admin]：" INITIAL_ADMIN_NAME
INITIAL_ADMIN_NAME="${INITIAL_ADMIN_NAME:-Super Admin}"
INITIAL_ADMIN_NAME="${INITIAL_ADMIN_NAME// /_}"
[[ "$INITIAL_ADMIN_NAME" =~ ^[A-Za-z0-9._-]{1,80}$ ]] \
  || die "管理员姓名只能包含英文字母、数字、点、下划线和连字符；空格会转为下划线"

while true; do
  read -r -s -p "首次超级管理员密码（至少 12 位）：" INITIAL_ADMIN_PASSWORD
  printf '\n'
  read -r -s -p "再次输入管理员密码：" INITIAL_ADMIN_PASSWORD_CONFIRM
  printf '\n'
  [[ ${#INITIAL_ADMIN_PASSWORD} -ge 12 ]] || { warn "密码不足 12 位"; continue; }
  [[ "$INITIAL_ADMIN_PASSWORD" == "$INITIAL_ADMIN_PASSWORD_CONFIRM" ]] \
    || { warn "两次密码不一致"; continue; }
  [[ "$INITIAL_ADMIN_PASSWORD" != *$'\n'* && "$INITIAL_ADMIN_PASSWORD" != *$'\r'* ]] \
    || { warn "密码不能包含换行"; continue; }
  break
done
unset INITIAL_ADMIN_PASSWORD_CONFIRM

install -d -m 0700 "$SECRETS_DIR" "$STATE_DIR" "$BACKUP_DIR"
printf '%s' "$INITIAL_ADMIN_PASSWORD" > "$SECRETS_DIR/initial_admin_password"
unset INITIAL_ADMIN_PASSWORD
openssl rand -hex 32 > "$SECRETS_DIR/mysql_password"
openssl rand -hex 32 > "$SECRETS_DIR/mysql_root_password"
openssl rand -hex 32 > "$SECRETS_DIR/postgres_password"
openssl rand -base64 32 | tr -d '\n' > "$SECRETS_DIR/communication_session_key"

generate_hex() { openssl rand -hex 32; }
cat > "$SECRETS_DIR/crm_runtime_env" <<EOF
JWT_SECRET=$(generate_hex)
PLATFORM_MFA_ENCRYPTION_KEY=$(generate_hex)
PROVIDER_CREDENTIAL_KEY=$(generate_hex)
EMAIL_TRACKING_SECRET=$(generate_hex)
AGENT_JOB_ENCRYPTION_KEY=$(generate_hex)
TRADE_OBSERVATION_CURSOR_SECRET=$(generate_hex)
MARKET_OPPORTUNITY_CURSOR_SECRET=$(generate_hex)
PROSPECT_RUN_IDEMPOTENCY_SECRET=$(generate_hex)
PROSPECT_RUN_CURSOR_SECRET=$(generate_hex)
ORGANIZATION_IDENTITY_MASTER_SECRET=$(generate_hex)
PROSPECT_SOURCE_RAW_ENVELOPE_SECRET=$(generate_hex)
PROSPECT_COVERAGE_MASTER_SECRET=$(generate_hex)
MYSQL_DATA_IMPORT_TOKEN=$(generate_hex)
EOF
chmod 0600 "$SECRETS_DIR"/*

cat > "$ENV_FILE" <<EOF
COMPOSE_PROJECT_NAME=goodjobcrm
GOODJOB_SHARED_DIR=$SHARED_DIR
DOMAIN=$DOMAIN
PUBLIC_SCHEME=$PUBLIC_SCHEME
PUBLIC_ORIGIN=$PUBLIC_SCHEME://$DOMAIN
SESSION_COOKIE_SECURE=$SESSION_COOKIE_SECURE
GOODJOB_HTTP_PORT=4188
INITIAL_ADMIN_EMAIL=$INITIAL_ADMIN_EMAIL
INITIAL_ADMIN_NAME=$INITIAL_ADMIN_NAME
MYSQL_DATABASE=goodjob_crm_prod
MYSQL_USER=goodjob_crm_app
ENABLE_API_DOCS=true
GOODJOB_BACKUP_RETENTION_COUNT=10
MYSQL_MEMORY_LIMIT=640m
MYSQL_CPU_LIMIT=1.0
BACKEND_MEMORY_LIMIT=640m
BACKEND_CPU_LIMIT=1.5
COMMUNICATION_MEMORY_LIMIT=384m
COMMUNICATION_CPU_LIMIT=1.0
EOF
chmod 0600 "$ENV_FILE"

log "配置已写入 $SHARED_DIR"
log "密码只保存在 $SECRETS_DIR，安装包和 Compose 文件不含明文密码"
log "下一步执行：./preflight.sh"
