#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="${APP_ROOT:-/www/server/goodjob-crm}"
APP_USER="${APP_USER:-goodjob-crm}"
CURRENT_LINK="${APP_ROOT}/current"
SHARED_DIR="${APP_ROOT}/shared"
ENV_FILE="${ENV_FILE:-$SHARED_DIR/.env}"
BETA_ADMIN_CREDENTIALS_FILE="${BETA_ADMIN_CREDENTIALS_FILE:-$SHARED_DIR/beta-admin-credentials.txt}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

die() { printf '错误：%s\n' "$*" >&2; exit 1; }

[[ -x "$NODE_BIN" ]] || die "未找到 Node.js"
[[ -f "$ENV_FILE" ]] || die "未找到运行环境：$ENV_FILE"
[[ -f "$CURRENT_LINK/backend/dist/provision-beta-admins.js" ]] \
  || die "当前版本缺少 40 个管理员预置脚本，请先部署包含该脚本的版本"

set -a
source "$ENV_FILE"
set +a
[[ -n "${DATABASE_URL:-}" ]] || die "运行环境中缺少 DATABASE_URL"

provision_beta_admins() {
  DATABASE_URL="$DATABASE_URL" \
  BETA_ADMIN_CREDENTIALS_FILE="$BETA_ADMIN_CREDENTIALS_FILE" \
  REMOVE_PRIMARY_ADMIN=true \
  "$NODE_BIN" "$CURRENT_LINK/backend/dist/provision-beta-admins.js"
  chmod 0600 "$BETA_ADMIN_CREDENTIALS_FILE"
  chown "$APP_USER:$APP_USER" "$BETA_ADMIN_CREDENTIALS_FILE" 2>/dev/null || true
  printf '40 个管理员凭据文件：%s\n' "$BETA_ADMIN_CREDENTIALS_FILE"
}

reset_primary_admin_password() {
  local password=""
  local confirmation=""
  read -r -s -p '请输入 admin@goodjob.com 新密码（至少 8 位）：' password
  printf '\n'
  read -r -s -p '请再次输入新密码：' confirmation
  printf '\n'
  [[ "$password" == "$confirmation" ]] || die "两次密码不一致"
  [[ ${#password} -ge 8 ]] || die "密码至少 8 位"

  (
    cd "$CURRENT_LINK/backend/dist"
    ADMIN_PASSWORD="$password" \
    DATABASE_URL="$DATABASE_URL" \
    "$NODE_BIN" --input-type=module <<'NODE'
import mysql from "mysql2/promise";
import { hashPassword } from "./auth.js";

const password = process.env.ADMIN_PASSWORD || "";
if (!password) throw new Error("新密码为空");
const connection = await mysql.createConnection(process.env.DATABASE_URL);
try {
  const passwordHash = await hashPassword(password);
  const [result] = await connection.execute(
    "UPDATE users SET password_hash = ?, auth_version = auth_version + 1 WHERE email = ? AND role = 'admin'",
    [passwordHash, "admin@goodjob.com"]
  );
  if (!Number(result.affectedRows || 0)) throw new Error("未找到 admin@goodjob.com");
  console.log("admin@goodjob.com 密码已更新，旧登录会话已失效");
} finally {
  await connection.end();
}
NODE
  )
}

case "${1:-}" in
  --provision-beta-admins) provision_beta_admins ;;
  --reset-admin-password) reset_primary_admin_password ;;
  --all)
    provision_beta_admins
    reset_primary_admin_password
    ;;
  *)
    cat >&2 <<EOF
用法：
  sudo bash $SCRIPT_DIR/manage-accounts.sh --provision-beta-admins
  sudo bash $SCRIPT_DIR/manage-accounts.sh --reset-admin-password
  sudo bash $SCRIPT_DIR/manage-accounts.sh --all
EOF
    exit 2
    ;;
esac
