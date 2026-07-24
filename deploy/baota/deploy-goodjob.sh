#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_APP_ROOT="${APP_ROOT:-/www/server/goodjob-crm}"
LOCAL_CONFIG_FILE="$SCRIPT_DIR/deploy.conf"
DEFAULT_SHARED_CONFIG_FILE="$DEFAULT_APP_ROOT/shared/deploy.conf"
CONFIG_FILE="${CONFIG_FILE:-}"
if [[ -z "$CONFIG_FILE" ]]; then
  if [[ -f "$LOCAL_CONFIG_FILE" ]]; then
    CONFIG_FILE="$LOCAL_CONFIG_FILE"
  elif [[ -f "$DEFAULT_SHARED_CONFIG_FILE" ]]; then
    CONFIG_FILE="$DEFAULT_SHARED_CONFIG_FILE"
  else
    CONFIG_FILE="$LOCAL_CONFIG_FILE"
  fi
fi
INSTALLER="$SCRIPT_DIR/install-baota.sh"
APP_ROOT="$DEFAULT_APP_ROOT"
SERVICE_NAME="${SERVICE_NAME:-goodjob-crm}"
WHATSAPP_PLUGIN_SERVICE_NAME="${WHATSAPP_PLUGIN_SERVICE_NAME:-goodjob-crm-whatsapp}"
BACKEND_PORT="${BACKEND_PORT:-4188}"
WHATSAPP_PLUGIN_PORT="${WHATSAPP_PLUGIN_PORT:-3100}"
VHOST_DIR="${VHOST_DIR:-/www/server/panel/vhost/nginx}"
NGINX_MANAGED_DIR="${NGINX_MANAGED_DIR:-$VHOST_DIR/goodjob-crm}"
MODE=install
REPORT_FILE=""
NGINX_BIN=""
VHOST_FILE=""
HTTPS_ACTIVE=false
EXPECTED_ORIGIN=""
FAILURE_REASON=""
KNOWN_FAILURE_HINT=""
SHARED_CONFIG_FILE=""
INSTALL_LOG=""
TEMP_DIR=""

blue() { printf '\n\033[1;34m[%s]\033[0m %s\n' "$(date '+%H:%M:%S')" "$*"; }
green() { printf '\033[1;32m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m警告：%s\033[0m\n' "$*" >&2; }
die() { FAILURE_REASON="$*"; printf '\033[1;31m错误：%s\033[0m\n' "$*" >&2; return 1; }

is_true() {
  case "${1:-}" in
    1|true|TRUE|True|yes|YES|Yes|y|Y|on|ON|On) return 0 ;;
    *) return 1 ;;
  esac
}

usage() {
  cat <<'EOF'
GoodJob CRM 宝塔可靠部署入口

安装或升级：
  sudo bash deploy-goodjob.sh

只做部署前检查：
  sudo bash deploy-goodjob.sh --preflight-only

检查当前线上部署并输出诊断报告：
  sudo bash deploy-goodjob.sh --verify-only

只校验上传包：
  bash deploy-goodjob.sh --check-package
EOF
}

for argument in "$@"; do
  case "$argument" in
    --preflight-only) MODE=preflight ;;
    --verify-only|--doctor) MODE=verify ;;
    --check-package) MODE=package ;;
    --help|-h) usage; exit 0 ;;
    *) printf '未知参数：%s\n' "$argument" >&2; exit 2 ;;
  esac
done

if [[ "$MODE" == package ]]; then
  exec bash "$INSTALLER" --check-package
fi

if [[ "$(id -u)" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    printf '需要 root 权限，正在通过 sudo 重新执行。\n'
    exec sudo env CONFIG_FILE="$CONFIG_FILE" bash "$0" "$@"
  fi
  printf '请使用 root 登录，或执行：sudo bash %s\n' "$0" >&2
  exit 1
fi

if [[ ! -f "$CONFIG_FILE" ]]; then
  cat >&2 <<EOF
未找到部署配置：$CONFIG_FILE
脚本也已检查升级共享配置：$DEFAULT_SHARED_CONFIG_FILE
请先执行：
  cp "$SCRIPT_DIR/deploy.conf.example" "$SCRIPT_DIR/deploy.conf"
然后填写 DOMAIN、DB_NAME、DB_USER、DB_PASSWORD。
EOF
  exit 1
fi

set -a
# deploy.conf 仅由服务器管理员维护，按 shell 配置文件读取。
source "$CONFIG_FILE"
set +a

DOMAIN="${DOMAIN:-}"
APP_ROOT="${APP_ROOT:-/www/server/goodjob-crm}"
SERVICE_NAME="${SERVICE_NAME:-goodjob-crm}"
WHATSAPP_PLUGIN_SERVICE_NAME="${WHATSAPP_PLUGIN_SERVICE_NAME:-goodjob-crm-whatsapp}"
BACKEND_PORT="${BACKEND_PORT:-4188}"
WHATSAPP_PLUGIN_PORT="${WHATSAPP_PLUGIN_PORT:-3100}"
VHOST_DIR="${VHOST_DIR:-/www/server/panel/vhost/nginx}"
NGINX_MANAGED_DIR="${NGINX_MANAGED_DIR:-$VHOST_DIR/goodjob-crm}"
REPORT_FILE="$APP_ROOT/shared/deployment-report.txt"
SHARED_CONFIG_FILE="$APP_ROOT/shared/deploy.conf"
INSTALL_LOG="$APP_ROOT/shared/last-install.log"
TEMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

find_command() {
  local name="$1"
  shift
  if command -v "$name" >/dev/null 2>&1; then
    command -v "$name"
    return
  fi
  local candidate=""
  for candidate in "$@"; do
    [[ -x "$candidate" ]] && { printf '%s\n' "$candidate"; return; }
  done
  return 1
}

find_compatible_node() {
  local candidate=""
  local major="0"
  local candidates=()
  if command -v node >/dev/null 2>&1; then
    candidates+=("$(command -v node)")
  fi
  while IFS= read -r candidate; do
    candidates+=("$candidate")
  done < <(compgen -G "/www/server/nodejs/*/bin/node" || true)
  for candidate in "${candidates[@]}"; do
    [[ -x "$candidate" ]] || continue
    major="$("$candidate" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0')"
    if [[ "$major" =~ ^[0-9]+$ ]] && (( major >= 22 )); then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

check_runtime() {
  local required=""
  local node_bin=""
  local npm_bin=""
  local project_name=""
  local plugin_name=""
  local psql_bin=""
  local postgres_major=0
  for required in bash awk sed rsync curl openssl tar gzip systemctl runuser; do
    command -v "$required" >/dev/null 2>&1 \
      || { die "缺少必需命令：$required"; return 1; }
  done

  node_bin="$(find_compatible_node 2>/dev/null || true)"
  if [[ -n "$node_bin" && -x "$(dirname "$node_bin")/npm" ]]; then
    npm_bin="$(dirname "$node_bin")/npm"
  else
    npm_bin="$(find_command npm /www/server/nodejs/*/bin/npm 2>/dev/null || true)"
  fi
  [[ -n "$node_bin" && -n "$npm_bin" ]] \
    || { die "未找到 Node.js/npm，请在宝塔安装 Node.js 22+"; return 1; }
  project_name="$("$npm_bin" --prefix "$SCRIPT_DIR" pkg get name 2>/dev/null | tr -d '\r\n"')"
  plugin_name="$("$npm_bin" --prefix "$SCRIPT_DIR/whatsapp-plugin" pkg get name 2>/dev/null | tr -d '\r\n"')"
  [[ "$project_name" == "goodjob-crm" ]] \
    || { die "npm --prefix 未定位到 CRM 安装包，检查 package.json 和 npm 版本"; return 1; }
  [[ "$plugin_name" == "whatsapp-crm-plugin" ]] \
    || { die "npm --prefix 未定位到 Communication 安装包"; return 1; }

  psql_bin="$(find_command psql /www/server/pgsql/bin/psql /usr/bin/psql 2>/dev/null || true)"
  [[ -n "$psql_bin" ]] \
    || { die "未找到 PostgreSQL 客户端，Communication 生产环境需要 PostgreSQL 14+"; return 1; }
  postgres_major="$("$psql_bin" --version | sed -nE 's/.* ([0-9]+)(\..*)?$/\1/p')"
  [[ "$postgres_major" =~ ^[0-9]+$ ]] && (( postgres_major >= 14 )) \
    || { die "PostgreSQL 客户端版本过低：$("$psql_bin" --version)"; return 1; }

  printf '运行环境：Node %s / npm %s / PostgreSQL %s\n' \
    "$("$node_bin" -v)" "$("$npm_bin" -v)" "$("$psql_bin" --version)"
}

check_upgrade_database() {
  local mysql_bin=""
  local engine_info=""
  local table_count=""
  mysql_bin="$(find_command mysql /www/server/mysql/bin/mysql /usr/bin/mysql 2>/dev/null || true)"
  [[ -n "$mysql_bin" ]] || { die "未找到 MySQL 客户端"; return 1; }

  if ! MYSQL_PWD="$DB_PASSWORD" "$mysql_bin" \
    --protocol=TCP --connect-timeout=10 --default-character-set=utf8mb4 \
    -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -N -B -e 'SELECT 1;' \
    >/dev/null 2>&1; then
    if [[ -L "$APP_ROOT/current" ]]; then
      die "已安装系统无法使用 deploy.conf 中的 DB_USER/DB_PASSWORD 连接 MySQL"
      return 1
    fi
    warn "业务数据库尚不可登录；首次安装将由底层安装器按 AUTO_CREATE_DATABASE 处理"
    return 0
  fi

  engine_info="$(MYSQL_PWD="$DB_PASSWORD" "$mysql_bin" \
    --protocol=TCP --connect-timeout=10 --default-character-set=utf8mb4 \
    -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -N -B \
    -e 'SELECT VERSION(), @@version_comment;' 2>/dev/null || true)"
  if [[ "$engine_info" =~ [Mm]ariaDB || ! "$engine_info" =~ ^8\. ]]; then
    die "当前数据库不受支持：$engine_info。需要 MySQL 8.0+，不支持 MariaDB 10.x"
    return 1
  fi

  table_count="$(MYSQL_PWD="$DB_PASSWORD" "$mysql_bin" \
    --protocol=TCP --connect-timeout=10 --default-character-set=utf8mb4 \
    -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -N -B \
    -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${DB_NAME}';" \
    2>/dev/null || true)"
  [[ "$table_count" =~ ^[0-9]+$ ]] \
    || { die "无法读取数据库 $DB_NAME 的表数量"; return 1; }
  if (( table_count > 0 )); then
    if is_true "${REUSE_EXISTING_DATABASE:-false}"; then
      printf '升级模式：读取已有数据库（%s 张表）并增量补齐，不导出业务数据\n' "$table_count"
    elif is_true "${REPLACE_DATABASE:-false}"; then
      die "REPLACE_DATABASE=true 已被禁用；部署器不会清空已有数据库"
      return 1
    else
      die "检测到已有数据库（$table_count 张表）。升级必须设置 REUSE_EXISTING_DATABASE=true"
      return 1
    fi
  fi
}

persist_upgrade_config() {
  local temp_config=""
  install -d -m 0750 "$APP_ROOT/shared"
  temp_config="$(mktemp "$APP_ROOT/shared/.deploy.conf.XXXXXX")"
  awk '
    /^REUSE_EXISTING_DATABASE=/ { print "REUSE_EXISTING_DATABASE=true"; reuse=1; next }
    /^REPLACE_DATABASE=/ { print "REPLACE_DATABASE=false"; replace=1; next }
    { print }
    END {
      if (!reuse) print "REUSE_EXISTING_DATABASE=true"
      if (!replace) print "REPLACE_DATABASE=false"
    }
  ' "$CONFIG_FILE" > "$temp_config"
  install -o root -g root -m 0600 "$temp_config" "$SHARED_CONFIG_FILE"
  rm -f "$temp_config"
  printf '下次升级配置已安全保存：%s\n' "$SHARED_CONFIG_FILE"
}

find_nginx() {
  if [[ -x /www/server/nginx/sbin/nginx ]]; then
    NGINX_BIN=/www/server/nginx/sbin/nginx
  elif command -v nginx >/dev/null 2>&1; then
    NGINX_BIN="$(command -v nginx)"
  else
    die "未找到 Nginx；宝塔环境应存在 /www/server/nginx/sbin/nginx"
    return 1
  fi
}

validate_domain() {
  [[ -n "${DOMAIN:-}" && "$DOMAIN" != "crm.example.com" ]] \
    || { die "请在 deploy.conf 中填写正式 DOMAIN"; return 1; }
  [[ "$DOMAIN" == "${DOMAIN,,}" ]] \
    || { die "DOMAIN 必须使用小写：${DOMAIN,,}"; return 1; }
  [[ "$DOMAIN" != *://* ]] \
    || { die "DOMAIN 只填域名，不能包含 http:// 或 https://"; return 1; }
  [[ "$DOMAIN" != */* ]] \
    || { die "DOMAIN 不能包含路径或末尾斜杠"; return 1; }
  [[ "$DOMAIN" != *'*'* && "$DOMAIN" != *'`'* && "$DOMAIN" != *'"'* && "$DOMAIN" != *"'"* ]] \
    || { die "DOMAIN 含有 Markdown 或引号，请只填写纯域名"; return 1; }
  [[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] \
    || { die "DOMAIN 格式不正确：$DOMAIN"; return 1; }
}

validate_config() {
  local boolean_name=""
  local boolean_value=""
  for boolean_name in AUTO_CREATE_DATABASE AUTO_CREATE_SITE REUSE_EXISTING_DATABASE \
    REPLACE_DATABASE ALLOW_NONEMPTY_WEB_ROOT PROVISION_BETA_ADMINS \
    REMOVE_PRIMARY_ADMIN NON_INTERACTIVE; do
    boolean_value="${!boolean_name:-false}"
    case "$boolean_value" in
      1|0|true|false|TRUE|FALSE|yes|no|YES|NO|on|off|ON|OFF) ;;
      *) die "$boolean_name 只能填写 true 或 false，当前为：$boolean_value"; return 1 ;;
    esac
  done
  if is_true "${REPLACE_DATABASE:-false}"; then
    die "REPLACE_DATABASE=true 已被禁用；升级只允许读取现有数据库并增量补齐"
    return 1
  fi
  [[ -n "${DB_NAME:-}" && -n "${DB_USER:-}" && -n "${DB_PASSWORD:-}" ]] \
    || { die "DB_NAME、DB_USER、DB_PASSWORD 均不能为空"; return 1; }
  [[ "$DB_PASSWORD" != *'请替换'* ]] \
    || { die "DB_PASSWORD 仍是模板值"; return 1; }
  [[ "${BACKEND_PORT:-}" =~ ^[0-9]+$ && "${WHATSAPP_PLUGIN_PORT:-}" =~ ^[0-9]+$ ]] \
    || { die "BACKEND_PORT 和 WHATSAPP_PLUGIN_PORT 必须是数字"; return 1; }
  [[ "$BACKEND_PORT" != "$WHATSAPP_PLUGIN_PORT" ]] \
    || { die "CRM 与 Communication 后端端口不能相同"; return 1; }
}

locate_vhost() {
  local candidate=""
  if [[ -n "${VHOST_FILE:-}" && -f "$VHOST_FILE" ]]; then
    return
  fi
  if [[ -f "$VHOST_DIR/$DOMAIN.conf" ]]; then
    VHOST_FILE="$VHOST_DIR/$DOMAIN.conf"
  elif [[ -f "$VHOST_DIR/proxy/$DOMAIN.conf" ]]; then
    VHOST_FILE="$VHOST_DIR/proxy/$DOMAIN.conf"
  elif [[ -d "$VHOST_DIR/proxy/$DOMAIN" ]]; then
    candidate="$(grep -RIl --include='*.conf' \
      -E "server_name[[:space:]]+([^;]*[[:space:]])?$DOMAIN([[:space:];]|$)" \
      "$VHOST_DIR/proxy/$DOMAIN" 2>/dev/null | sed -n '1p' || true)"
    VHOST_FILE="${candidate:-$VHOST_DIR/$DOMAIN.conf}"
  else
    VHOST_FILE="$VHOST_DIR/$DOMAIN.conf"
  fi
}

check_domain_binding() {
  local similar=""
  locate_vhost
  if [[ ! -f "$VHOST_FILE" ]]; then
    if is_true "${AUTO_CREATE_SITE:-false}" && [[ "$MODE" != verify ]]; then
      warn "尚未找到 $DOMAIN 的宝塔站点，安装器将自动创建"
      return 0
    fi
    similar="$(find "$VHOST_DIR" -maxdepth 2 -type f -name '*.conf' 2>/dev/null \
      | sed 's#.*/##; s/\.conf$//' | grep -F "${DOMAIN#*.}" | head -n 5 || true)"
    [[ -z "$similar" ]] || warn "发现相近站点：$similar"
    die "未找到域名对应的宝塔 Nginx 配置：$VHOST_FILE"
    return 1
  fi
  awk -v domain="$DOMAIN" '
    /^[[:space:]]*server_name[[:space:]]+/ {
      for (field_no=2; field_no<=NF; field_no++) {
        value=$field_no
        sub(/;$/, "", value)
        if (value == domain) found=1
      }
    }
    END { exit(found ? 0 : 1) }
  ' "$VHOST_FILE" \
    || { die "域名与宝塔站点不一致：$VHOST_FILE 的 server_name 未绑定 $DOMAIN"; return 1; }

  if grep -Eq '^[[:space:]]*(listen[[:space:]][^;]*443[^;]*ssl|ssl_certificate[[:space:]]+)' "$VHOST_FILE"; then
    HTTPS_ACTIVE=true
    EXPECTED_ORIGIN="https://$DOMAIN"
  else
    HTTPS_ACTIVE=false
    EXPECTED_ORIGIN="http://$DOMAIN"
  fi
}

check_duplicate_includes() {
  [[ -f "$VHOST_FILE" ]] || return 0
  local include_count=0
  local expected="$NGINX_MANAGED_DIR/$DOMAIN.conf"
  include_count="$(grep -Fc "include $expected;" "$VHOST_FILE" || true)"
  (( include_count <= 1 )) \
    || { die "宝塔站点重复加载 CRM 配置，请删除重复 include：$expected"; return 1; }
  if grep -E 'include[[:space:]]+[^;]*/goodjob-crm/[^;]+\.conf;' "$VHOST_FILE" \
    | grep -Fv "include $expected;" >/dev/null; then
    die "宝塔站点加载了其他域名的旧 CRM 配置，请检查 $VHOST_FILE"
    return 1
  fi
}

check_dns() {
  local resolved=""
  local public_ip=""
  if command -v getent >/dev/null 2>&1; then
    resolved="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | paste -sd, - || true)"
  elif command -v dig >/dev/null 2>&1; then
    resolved="$(dig +short A "$DOMAIN" 2>/dev/null | sort -u | paste -sd, - || true)"
  fi
  [[ -n "$resolved" ]] || { warn "DNS 尚未解析或服务器暂时无法查询 $DOMAIN"; return 0; }
  public_ip="$(curl -4fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  if [[ -n "$public_ip" && ",$resolved," != *",$public_ip,"* ]]; then
    warn "域名 $DOMAIN 当前解析为 $resolved，本机公网 IP 为 $public_ip；若使用 CDN 可忽略，否则请修正 A 记录"
  else
    printf 'DNS：%s -> %s\n' "$DOMAIN" "$resolved"
  fi
}

check_ports() {
  local port=""
  local service=""
  local listener=""
  command -v ss >/dev/null 2>&1 || return 0
  for port in "$BACKEND_PORT" "$WHATSAPP_PLUGIN_PORT"; do
    if [[ "$port" == "$BACKEND_PORT" ]]; then
      service="$SERVICE_NAME"
    else
      service="$WHATSAPP_PLUGIN_SERVICE_NAME"
    fi
    listener="$(ss -lntp 2>/dev/null | awk -v suffix=":$port" '$4 ~ suffix "$" {print; exit}')"
    [[ -n "$listener" ]] || continue
    if systemctl is-active --quiet "$service" 2>/dev/null; then
      warn "端口 $port 正由现有 $service 使用，按代码升级处理"
    else
      die "端口 $port 已被非预期进程占用，继续安装会触发 EADDRINUSE：$listener"
      return 1
    fi
  done
}

preflight() {
  blue "部署前检查域名、配置、宝塔站点和安装包"
  printf '配置来源：%s\n' "$CONFIG_FILE"
  validate_domain || return 1
  validate_config || return 1
  check_runtime || return 1
  check_upgrade_database || return 1
  find_nginx || return 1
  check_domain_binding || return 1
  check_duplicate_includes || return 1
  check_dns
  check_ports || return 1
  bash "$INSTALLER" --check-package || { die "安装包校验失败"; return 1; }
  "$NGINX_BIN" -t || { die "宝塔 Nginx 现有配置校验失败"; return 1; }
  green "部署前检查通过"
}

curl_public_to_file() {
  local path="$1"
  local destination="$2"
  if [[ "$HTTPS_ACTIVE" == true ]]; then
    curl -kfsSL --connect-timeout 8 --max-time 30 \
      --noproxy '*' --resolve "$DOMAIN:443:127.0.0.1" \
      -o "$destination" "https://$DOMAIN$path"
  else
    curl -fsSL --connect-timeout 8 --max-time 30 \
      --noproxy '*' -H "Host: $DOMAIN" \
      -o "$destination" "http://127.0.0.1$path"
  fi
}

assert_http_200() {
  local path="$1"
  local label="$2"
  local code=""
  if [[ "$HTTPS_ACTIVE" == true ]]; then
    code="$(curl -ksSL -o /dev/null -w '%{http_code}' --connect-timeout 8 --max-time 30 \
      --noproxy '*' --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN$path" || true)"
  else
    code="$(curl -sSL -o /dev/null -w '%{http_code}' --connect-timeout 8 --max-time 30 \
      --noproxy '*' -H "Host: $DOMAIN" "http://127.0.0.1$path" || true)"
  fi
  [[ "$code" == 200 ]] || { die "$label 返回 HTTP $code（期望 200）"; return 1; }
}

verify_permissions() {
  local current="$APP_ROOT/current"
  local release=""
  [[ -r "$current/frontend/dist/index.html" ]] \
    || { die "CRM 首页文件不存在或 root 不可读"; return 1; }
  [[ -r "$current/whatsapp-plugin/dist/index.html" ]] \
    || { die "Communication 首页文件不存在或 root 不可读"; return 1; }
  find "$current/frontend/dist" -type d -exec chmod 0755 {} +
  find "$current/frontend/dist" -type f -exec chmod 0644 {} +
  find "$current/whatsapp-plugin/dist" -type d -exec chmod 0755 {} +
  find "$current/whatsapp-plugin/dist" -type f -exec chmod 0644 {} +
  release="$(readlink -f "$current" 2>/dev/null || true)"
  [[ -n "$release" && -d "$release" ]] \
    || { die "当前版本链接无效：$current"; return 1; }
  # Nginx 通常不是 goodjob-crm 用户，发布链路上的非敏感目录必须允许穿过。
  chmod 0755 "$APP_ROOT" "$release" \
    "$release/frontend" "$release/frontend/dist" \
    "$release/whatsapp-plugin" "$release/whatsapp-plugin/dist"
  local path=""
  for path in "$APP_ROOT" "$release" "$release/frontend" "$release/frontend/dist" \
    "$release/whatsapp-plugin" "$release/whatsapp-plugin/dist"; do
    case "$(stat -c '%a' "$path" 2>/dev/null | tail -c 2)" in
      1|3|5|7) ;;
      *) die "Nginx 无法穿过目录 $path，可能导致 403"; return 1 ;;
    esac
  done
}

verify_environment() {
  local crm_env="$APP_ROOT/shared/.env"
  local plugin_env="$APP_ROOT/shared/whatsapp-plugin.env"
  local cors_origins=""
  [[ -f "$crm_env" ]] || { die "缺少 CRM 环境文件：$crm_env"; return 1; }
  [[ -f "$plugin_env" ]] || { die "缺少 Communication 环境文件：$plugin_env"; return 1; }
  cors_origins="$(sed -n 's/^CORS_ORIGINS=//p' "$crm_env" | tail -n 1)"
  [[ ",$cors_origins," == *",$EXPECTED_ORIGIN,"* ]] \
    || { die "CORS_ORIGINS 未包含 $EXPECTED_ORIGIN；这会导致“不允许的请求源”或 403"; return 1; }
  grep -Fxq "WEB_ORIGIN=$EXPECTED_ORIGIN" "$plugin_env" \
    || { die "WEB_ORIGIN 与当前域名/协议不一致，应为 $EXPECTED_ORIGIN"; return 1; }
  grep -Fxq 'DATABASE_CLIENT=postgres' "$plugin_env" \
    || { die "Communication 生产环境必须配置 DATABASE_CLIENT=postgres"; return 1; }
}

verify_nginx_routes() {
  local managed="$NGINX_MANAGED_DIR/$DOMAIN.conf"
  local runtime_file="$TEMP_DIR/nginx-runtime.txt"
  [[ -f "$managed" ]] || { die "缺少 CRM Nginx 配置：$managed"; return 1; }
  grep -Fq 'location = /whatsapp-plugin/index.html {' "$managed" \
    || { die "Communication 缺少独立首页路由"; return 1; }
  grep -Fq "alias $APP_ROOT/current/whatsapp-plugin/dist/index.html;" "$managed" \
    || { die "Communication 首页 alias 不正确"; return 1; }
  grep -Fq 'location ^~ /whatsapp-plugin/assets/ {' "$managed" \
    || { die "Communication 静态资源路由缺失"; return 1; }
  if grep -Eq 'rewrite[[:space:]]+\^/whatsapp-plugin/|try_files[^;]+/whatsapp-plugin/index.html' "$managed"; then
    die "检测到会打开 CRM 主界面或触发 index.htmlindex.php 的旧 Communication 路由"
    return 1
  fi
  "$NGINX_BIN" -t || { die "宝塔 Nginx 配置校验失败"; return 1; }
  "$NGINX_BIN" -T > "$runtime_file" 2>&1 || true
  grep -Fq "$managed" "$runtime_file" \
    || { die "Nginx 没有实际加载 $managed；仅写入文件并不代表配置已生效"; return 1; }
}

verify_services() {
  systemctl is-active --quiet "$SERVICE_NAME" \
    || { die "CRM 服务未运行：$SERVICE_NAME"; return 1; }
  systemctl is-active --quiet "$WHATSAPP_PLUGIN_SERVICE_NAME" \
    || { die "Communication 服务未运行：$WHATSAPP_PLUGIN_SERVICE_NAME"; return 1; }
  curl -fsS "http://127.0.0.1:$BACKEND_PORT/api/health" \
    | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' \
    || { die "CRM 本机后端健康检查失败"; return 1; }
  curl -fsS "http://127.0.0.1:$WHATSAPP_PLUGIN_PORT/api/health" \
    | grep -Eq '"ready"[[:space:]]*:[[:space:]]*true' \
    || { die "Communication 本机后端健康检查失败"; return 1; }
}

verify_public_pages() {
  local asset=""
  local crm_health_file="$TEMP_DIR/crm-health.json"
  local crm_home_file="$TEMP_DIR/crm-home.html"
  local communication_file="$TEMP_DIR/communication.html"
  local communication_health_file="$TEMP_DIR/communication-health.json"
  assert_http_200 "/api/health" "CRM 公开健康接口" || return 1
  curl_public_to_file "/api/health" "$crm_health_file" \
    || { die "无法读取 CRM 公开健康接口"; return 1; }
  grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' "$crm_health_file" \
    || { die "CRM /api/health 未返回健康 JSON；可能仍由宝塔静态站点处理"; return 1; }

  assert_http_200 "/" "CRM 首页" || return 1
  curl_public_to_file "/" "$crm_home_file" \
    || { die "无法读取 CRM 首页"; return 1; }
  grep -Fq '<title>GoodJob CRM' "$crm_home_file" \
    || { die "域名首页不是 GoodJob CRM，请检查 server_name 和根路由"; return 1; }

  assert_http_200 "/whatsapp-plugin/?embedded=1" "Communication 页面" || return 1
  curl_public_to_file "/whatsapp-plugin/?embedded=1" "$communication_file" \
    || { die "无法读取 Communication 页面"; return 1; }
  grep -Fq '<title>WhatsApp CRM 插件控制台</title>' "$communication_file" \
    || { die "Communication 返回的不是独立插件页面，可能错误打开了 CRM 主界面"; return 1; }
  if grep -Fq '<title>GoodJob CRM' "$communication_file"; then
    die "Communication 路由错误返回了 CRM 主界面"
    return 1
  fi

  asset="$(sed -nE 's#.*(src|href)="([^\"]*/assets/[^\"]+)".*#\2#p' "$communication_file" | sed -n '1p')"
  if [[ -z "$asset" ]]; then
    asset="$(find "$APP_ROOT/current/whatsapp-plugin/dist/assets" -maxdepth 1 -type f \
      -printf '%f\n' 2>/dev/null | sed -n '1p')"
    [[ -n "$asset" ]] && asset="/whatsapp-plugin/assets/$asset"
  fi
  [[ -n "$asset" ]] || { die "Communication 构建中没有静态资源"; return 1; }
  [[ "$asset" == /* ]] || asset="/whatsapp-plugin/${asset#./}"
  assert_http_200 "$asset" "Communication 静态资源" || return 1

  assert_http_200 "/whatsapp-plugin/api/health" "Communication 公开健康接口" || return 1
  curl_public_to_file "/whatsapp-plugin/api/health" "$communication_health_file" \
    || { die "无法读取 Communication 公开健康接口"; return 1; }
  grep -Eq '"ready"[[:space:]]*:[[:space:]]*true' "$communication_health_file" \
    || { die "Communication 代理没有连接到插件后端"; return 1; }
}

write_report() {
  local result="$1"
  local reason="${2:-无}"
  if [[ ! -d "$APP_ROOT" && "$result" != "通过" ]]; then
    REPORT_FILE="/tmp/goodjob-crm-deployment-report.txt"
  else
    install -d -m 0750 "$APP_ROOT/shared"
  fi
  cat > "$REPORT_FILE" <<EOF
GoodJob CRM 部署验收报告
========================
时间：$(date '+%Y-%m-%d %H:%M:%S %Z')
结果：$result
配置来源：$CONFIG_FILE
域名：$DOMAIN
访问协议：$([[ "$HTTPS_ACTIVE" == true ]] && printf HTTPS || printf HTTP)
期望来源：$EXPECTED_ORIGIN
宝塔站点：$VHOST_FILE
CRM Nginx 配置：$NGINX_MANAGED_DIR/$DOMAIN.conf
CRM 服务：$SERVICE_NAME / 127.0.0.1:$BACKEND_PORT
Communication 服务：$WHATSAPP_PLUGIN_SERVICE_NAME / 127.0.0.1:$WHATSAPP_PLUGIN_PORT
失败原因：$reason
已识别故障：${KNOWN_FAILURE_HINT:-无}

已覆盖的历史故障：
1. 安装包缺少 package-lock.json、文件损坏或 npm --prefix 参数顺序错误。
2. MariaDB 10.x 导入 MySQL 8 生成列时报 ERROR 1901。
3. MySQL root 无密码登录失败，以及数据库名误当 shell 命令。
4. 升级时未启用 REUSE_EXISTING_DATABASE，或旧配置误启用了已禁用的 REPLACE_DATABASE。
5. Communication 生产环境误用非 PostgreSQL 数据库。
6. 调用系统 /etc/nginx 而非宝塔 /www/server/nginx。
7. 旧服务或残留进程占用 4188/3100，导致 EADDRINUSE。
8. DOMAIN 写成协议、路径、错误后缀或错误宝塔站点。
9. CORS_ORIGINS / WEB_ORIGIN 与正式域名或 HTTP/HTTPS 不一致。
10. Nginx include 未实际加载或静态目录权限不足，导致 403/404。
11. 旧 rewrite 返回 CRM 主界面或拼成 index.htmlindex.php，导致 Communication 500。
12. 大体积 CRM 首页通过 grep -q 管道验收时触发 SIGPIPE 141 假失败。
13. awk 使用 index 作为循环变量导致宝塔老环境语法冲突。

复查命令：sudo bash $SCRIPT_DIR/deploy-goodjob.sh --verify-only
服务日志：journalctl -u $SERVICE_NAME -u $WHATSAPP_PLUGIN_SERVICE_NAME -n 100 --no-pager
EOF
  chmod 0600 "$REPORT_FILE"
  printf '部署报告：%s\n' "$REPORT_FILE"
}

identify_known_failure() {
  local reason="${1:-}"
  local source_file="$INSTALL_LOG"
  KNOWN_FAILURE_HINT=""
  if [[ -f "$source_file" ]] && grep -Eqi 'EUSAGE|npm ci.*package-lock|can only install with an existing package-lock' "$source_file"; then
    KNOWN_FAILURE_HINT="npm 未在安装包目录读到 package-lock.json；检查包完整性和 --prefix 顺序"
  elif [[ -f "$source_file" ]] && grep -Eqi 'ERROR 1901|GENERATED ALWAYS|MariaDB' "$source_file"; then
    KNOWN_FAILURE_HINT="数据库引擎不兼容；GoodJob 需要 MySQL 8.0+，不支持 MariaDB 10.x"
  elif [[ -f "$source_file" ]] && grep -Eqi 'Access denied for user .root|MYSQL_ROOT_PASSWORD|root.*socket' "$source_file"; then
    KNOWN_FAILURE_HINT="MySQL root 认证失败；应填写 MYSQL_ROOT_PASSWORD 或使用已可登录的业务数据库用户"
  elif [[ -f "$source_file" ]] && grep -Eqi 'DATABASE_CLIENT must be postgres|PostgreSQL|psql' "$source_file"; then
    KNOWN_FAILURE_HINT="Communication 生产数据库未正确配置为 PostgreSQL 14+"
  elif [[ -f "$source_file" ]] && grep -Eqi '/etc/nginx/nginx.conf|could not open error log file' "$source_file"; then
    KNOWN_FAILURE_HINT="调用了系统 Nginx 而非宝塔 Nginx；应使用 /www/server/nginx/sbin/nginx"
  elif [[ -f "$source_file" ]] && grep -Eqi 'EADDRINUSE|address already in use|port [0-9]+.*占用' "$source_file"; then
    KNOWN_FAILURE_HINT="旧服务或残留进程仍占用 CRM/Communication 端口"
  elif [[ -f "$source_file" ]] && grep -Eqi 'index\.htmlindex\.php|打开.*CRM 主界面' "$source_file"; then
    KNOWN_FAILURE_HINT="Communication 仍命中宝塔旧 rewrite 或 PHP 回退规则"
  elif [[ -f "$source_file" ]] && grep -Eqi 'CORS|WEB_ORIGIN|不允许的请求源' "$source_file"; then
    KNOWN_FAILURE_HINT="正式域名协议与 CORS_ORIGINS/WEB_ORIGIN 不一致"
  elif [[ "$reason" == *"域名首页不是 GoodJob CRM"* ]]; then
    KNOWN_FAILURE_HINT="检查根路由；验收器已改为文件检测，不再因大页面 SIGPIPE 141 误判"
  elif [[ -f "$source_file" ]] && grep -Eqi '403 Forbidden|Permission denied' "$source_file"; then
    KNOWN_FAILURE_HINT="Nginx 访问发布目录或环境文件的权限不正确"
  fi
  [[ -z "$KNOWN_FAILURE_HINT" ]] || printf '已识别历史故障：%s\n' "$KNOWN_FAILURE_HINT" >&2
}

diagnose() {
  local reason="${1:-部署或验收失败}"
  set +e
  identify_known_failure "$reason"
  printf '\n\033[1;31m========== 自动诊断 =========\033[0m\n' >&2
  printf '原因：%s\n' "$reason" >&2
  printf '\n服务状态：\n' >&2
  systemctl --no-pager --full status "$SERVICE_NAME" "$WHATSAPP_PLUGIN_SERVICE_NAME" 2>&1 \
    | tail -n 80 >&2
  printf '\n最近服务日志：\n' >&2
  journalctl -u "$SERVICE_NAME" -u "$WHATSAPP_PLUGIN_SERVICE_NAME" -n 100 --no-pager >&2
  printf '\nNginx 相关配置：\n' >&2
  [[ -f "$VHOST_FILE" ]] && grep -nE 'server_name|listen|goodjob-crm' "$VHOST_FILE" >&2
  [[ -f "$NGINX_MANAGED_DIR/$DOMAIN.conf" ]] \
    && sed -n '1,220p' "$NGINX_MANAGED_DIR/$DOMAIN.conf" >&2
  printf '\n静态文件目录权限：\n' >&2
  command -v namei >/dev/null 2>&1 \
    && namei -l "$APP_ROOT/current/frontend/dist/index.html" \
      "$APP_ROOT/current/whatsapp-plugin/dist/index.html" >&2
  local error_log="/www/wwwlogs/$DOMAIN.error.log"
  if [[ -f "$error_log" ]]; then
    printf '\n宝塔错误日志：%s\n' "$error_log" >&2
    tail -n 100 "$error_log" >&2
  fi
  write_report "失败" "$reason" || true
  printf '\033[1;31m========== 诊断结束 =========\033[0m\n' >&2
}

verify_all() {
  blue "验收 CRM 与 Communication 的服务、配置、页面、接口和静态资源"
  find_nginx || return 1
  validate_domain || return 1
  validate_config || return 1
  check_domain_binding || return 1
  check_duplicate_includes || return 1
  verify_permissions || return 1
  verify_environment || return 1
  verify_nginx_routes || return 1
  verify_services || return 1
  verify_public_pages || return 1
  green "全部验收通过：CRM 与 Communication 页面、接口和静态资源均正常"
}

if [[ "$MODE" == preflight ]]; then
  if ! preflight; then
    diagnose "${FAILURE_REASON:-部署前检查失败}"
    exit 1
  fi
  exit 0
fi

if [[ "$MODE" == verify ]]; then
  if ! verify_all; then
    diagnose "${FAILURE_REASON:-线上验收失败}"
    exit 1
  fi
  write_report "通过"
  persist_upgrade_config
  exit 0
fi

if ! preflight; then
  diagnose "${FAILURE_REASON:-部署前检查失败}"
  exit 1
fi

blue "开始安装或升级"
install -d -m 0750 "$APP_ROOT/shared"
: > "$INSTALL_LOG"
chmod 0600 "$INSTALL_LOG"
set +e
CONFIG_FILE="$CONFIG_FILE" bash "$INSTALLER" 2>&1 | tee "$INSTALL_LOG"
installer_status=${PIPESTATUS[0]}
set -e
if (( installer_status != 0 )); then
  diagnose "底层安装器执行失败，请查看上方具体报错"
  exit 1
fi
persist_upgrade_config

# 安装器可能创建了站点，重新定位并判断 SSL 状态。
VHOST_FILE=""
if ! verify_all; then
  diagnose "${FAILURE_REASON:-部署后验收失败}"
  exit 1
fi
write_report "通过"
green "可靠部署完成；只有以上全部检查通过才会显示本消息。"
