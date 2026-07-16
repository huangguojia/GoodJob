#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${CONFIG_FILE:-$SCRIPT_DIR/deploy.conf}"

if [[ ! -f "$CONFIG_FILE" ]]; then
  cat >&2 <<EOF
未找到部署配置：$CONFIG_FILE

请先执行：
  cp "$SCRIPT_DIR/deploy.conf.example" "$SCRIPT_DIR/deploy.conf"

然后修改 deploy.conf 中的 DOMAIN、DB_NAME、DB_USER、DB_PASSWORD，
再执行：sudo bash "$SCRIPT_DIR/one-click-install.sh"
EOF
  exit 1
fi

set -a
# deploy.conf 是服务器管理员维护的受信任配置文件。
source "$CONFIG_FILE"
set +a

if [[ -z "${DOMAIN:-}" || "$DOMAIN" == "crm.example.com" ]]; then
  printf '请先在 %s 中填写服务器正式域名 DOMAIN。\n' "$CONFIG_FILE" >&2
  exit 1
fi
if [[ -z "${DB_NAME:-}" || -z "${DB_USER:-}" || -z "${DB_PASSWORD:-}" \
  || "$DB_PASSWORD" == *"请替换"* ]]; then
  printf '请先在 %s 中填写 DB_NAME、DB_USER、DB_PASSWORD。\n' "$CONFIG_FILE" >&2
  exit 1
fi
chmod 0600 "$CONFIG_FILE" 2>/dev/null || true

exec bash "$SCRIPT_DIR/install-baota.sh" "$@"
