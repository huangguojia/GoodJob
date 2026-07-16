#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUTPUT_DIR="${1:-$PROJECT_ROOT/dist-packages}"
TIMESTAMP="${PACKAGE_TIMESTAMP:-$(date +%Y%m%d-%H%M%S)}"
PACKAGE_NAME="GoodJob-CRM-Baota-$TIMESTAMP"
STAGING_ROOT="$(mktemp -d)"
STAGING_DIR="$STAGING_ROOT/$PACKAGE_NAME"
ARCHIVE_PATH="$OUTPUT_DIR/$PACKAGE_NAME.tar.gz"

cleanup() {
  rm -rf "$STAGING_ROOT"
}
trap cleanup EXIT

command -v rsync >/dev/null 2>&1 || {
  printf '缺少 rsync\n' >&2
  exit 1
}

mkdir -p "$OUTPUT_DIR" "$STAGING_DIR/backend" "$STAGING_DIR/frontend" "$STAGING_DIR/database"

cp "$PROJECT_ROOT/package.json" "$PROJECT_ROOT/package-lock.json" "$STAGING_DIR/"
cp "$PROJECT_ROOT/backend/package.json" "$PROJECT_ROOT/backend/tsconfig.json" "$STAGING_DIR/backend/"
cp "$PROJECT_ROOT/frontend/package.json" \
  "$PROJECT_ROOT/frontend/index.html" \
  "$PROJECT_ROOT/frontend/tsconfig.json" \
  "$PROJECT_ROOT/frontend/tsconfig.node.json" \
  "$PROJECT_ROOT/frontend/vite.config.ts" \
  "$STAGING_DIR/frontend/"

rsync -a \
  --exclude='*-test.ts' \
  --exclude='self-test.ts' \
  --exclude='provision-beta-admins.ts' \
  "$PROJECT_ROOT/backend/src/" "$STAGING_DIR/backend/src/"
rsync -a \
  --exclude='tests/' \
  --exclude='*.test.*' \
  --exclude='self-test.ts' \
  "$PROJECT_ROOT/frontend/src/" "$STAGING_DIR/frontend/src/"

sanitized_data="$(mktemp)"
awk '
  /^export const users: User\[\] = \[$/ {
    print "export const users: User[] = [];"
    skipping_users=1
    next
  }
  skipping_users && /^\];$/ {
    skipping_users=0
    next
  }
  !skipping_users {
    print
  }
  END {
    if (skipping_users) exit 42
  }
' "$STAGING_DIR/backend/src/data.ts" > "$sanitized_data"
mv "$sanitized_data" "$STAGING_DIR/backend/src/data.ts"

node - "$STAGING_DIR/backend/package.json" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
const value = JSON.parse(fs.readFileSync(file, "utf8"));
value.scripts = {
  build: value.scripts.build,
  start: value.scripts.start,
  "start:mysql": value.scripts["start:mysql"]
};
fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
NODE

cp "$PROJECT_ROOT/deploy/baota/install-baota.sh" "$STAGING_DIR/install-baota.sh"
cp "$PROJECT_ROOT/deploy/baota/one-click-install.sh" "$STAGING_DIR/one-click-install.sh"
cp "$PROJECT_ROOT/deploy/baota/manage-service.sh" "$STAGING_DIR/manage-service.sh"
cp "$PROJECT_ROOT/deploy/baota/deploy.conf.example" "$STAGING_DIR/deploy.conf.example"
cp "$PROJECT_ROOT/deploy/baota/BAOTA-INSTALL.txt" "$STAGING_DIR/BAOTA-INSTALL.txt"
cp "$PROJECT_ROOT/deploy/baota/database/bootstrap.sql.gz" "$STAGING_DIR/database/"
cp "$PROJECT_ROOT/deploy/baota/database/bootstrap.sql.gz.sha256" "$STAGING_DIR/database/"
chmod 0755 \
  "$STAGING_DIR/install-baota.sh" \
  "$STAGING_DIR/one-click-install.sh" \
  "$STAGING_DIR/manage-service.sh"

if find "$STAGING_DIR" -type f \( \
  -name '.env' \
  -o -name '*管理员名单*' \
  -o -name '*credentials*' \
  -o -name '*.sql' \
  -o -name '*.sql.gz' ! -path "$STAGING_DIR/database/bootstrap.sql.gz" \
\) -print -quit | grep -q .; then
  printf '打包目录中发现禁止文件\n' >&2
  exit 1
fi

if grep -ERqi \
  "(beta-admin-[0-9]{2}@goodjob-crm\\.com|super@goodjob\\.com)" \
  "$STAGING_DIR/backend/src" "$STAGING_DIR/frontend"; then
  printf '打包目录中发现公测管理员或超级管理员凭据\n' >&2
  exit 1
fi
grep -Fq 'id="loginEmail" value="admin@goodjob.com"' "$STAGING_DIR/frontend/index.html" \
  || { printf '登录界面缺少默认管理员账号\n' >&2; exit 1; }
grep -Fq 'id="loginPassword" type="password" value="goodjob123"' "$STAGING_DIR/frontend/index.html" \
  || { printf '登录界面缺少默认管理员密码\n' >&2; exit 1; }
if grep -ERqi "BEGIN (RSA|OPENSSH|EC|PRIVATE) KEY" "$STAGING_DIR"; then
  printf '打包目录中发现私钥\n' >&2
  exit 1
fi

tar -C "$STAGING_ROOT" -czf "$ARCHIVE_PATH" "$PACKAGE_NAME"
chmod 0600 "$ARCHIVE_PATH"

if command -v sha256sum >/dev/null 2>&1; then
  (
    cd "$OUTPUT_DIR"
    sha256sum "$(basename "$ARCHIVE_PATH")"
  ) > "$ARCHIVE_PATH.sha256"
else
  (
    cd "$OUTPUT_DIR"
    shasum -a 256 "$(basename "$ARCHIVE_PATH")"
  ) > "$ARCHIVE_PATH.sha256"
fi
chmod 0600 "$ARCHIVE_PATH.sha256"

printf '%s\n' "$ARCHIVE_PATH"
