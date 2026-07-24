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

printf '正在执行 CRM、前端和 WhatsApp 插件生产构建...\n'
npm --prefix "$PROJECT_ROOT" run build

for required_build in \
  "$PROJECT_ROOT/backend/dist/server.js" \
  "$PROJECT_ROOT/backend/dist/migrate-mysql.js" \
  "$PROJECT_ROOT/backend/dist/mysql-data-import.js" \
  "$PROJECT_ROOT/backend/dist/provision-beta-admins.js" \
  "$PROJECT_ROOT/frontend/dist/index.html" \
  "$PROJECT_ROOT/whatsapp-plugin/dist/index.html" \
  "$PROJECT_ROOT/whatsapp-plugin/dist-server/server/index.js"; do
  [[ -f "$required_build" ]] || { printf '缺少构建产物：%s\n' "$required_build" >&2; exit 1; }
done

mkdir -p "$OUTPUT_DIR" "$STAGING_DIR/backend" "$STAGING_DIR/frontend" \
  "$STAGING_DIR/whatsapp-plugin/LICENSES" "$STAGING_DIR/database" \
  "$STAGING_DIR/docs" "$STAGING_DIR/LICENSES" "$STAGING_DIR/agent-knowledge" \
  "$STAGING_DIR/agent-skills"

cp "$PROJECT_ROOT/package.json" "$PROJECT_ROOT/package-lock.json" "$STAGING_DIR/"
cp "$PROJECT_ROOT/LICENSE" "$PROJECT_ROOT/NOTICE" "$PROJECT_ROOT/AUTHORS.md" \
  "$PROJECT_ROOT/README.md" \
  "$PROJECT_ROOT/THIRD_PARTY_NOTICES.md" "$STAGING_DIR/"
cp "$PROJECT_ROOT/LICENSES/"*.txt "$STAGING_DIR/LICENSES/"
cp "$PROJECT_ROOT/agent-knowledge/"*.json "$STAGING_DIR/agent-knowledge/"
rsync -a "$PROJECT_ROOT/agent-skills/" "$STAGING_DIR/agent-skills/"
cp "$PROJECT_ROOT/backend/package.json" "$PROJECT_ROOT/backend/tsconfig.json" "$STAGING_DIR/backend/"
cp "$PROJECT_ROOT/frontend/package.json" \
  "$PROJECT_ROOT/frontend/index.html" \
  "$PROJECT_ROOT/frontend/tsconfig.json" \
  "$PROJECT_ROOT/frontend/tsconfig.node.json" \
  "$PROJECT_ROOT/frontend/vite.config.ts" \
  "$STAGING_DIR/frontend/"
cp "$PROJECT_ROOT/whatsapp-plugin/package.json" \
  "$PROJECT_ROOT/whatsapp-plugin/package-lock.json" \
  "$PROJECT_ROOT/whatsapp-plugin/LICENSE" \
  "$PROJECT_ROOT/whatsapp-plugin/README.md" \
  "$PROJECT_ROOT/whatsapp-plugin/THIRD_PARTY_NOTICES.md" \
  "$PROJECT_ROOT/whatsapp-plugin/tsconfig.json" \
  "$PROJECT_ROOT/whatsapp-plugin/tsconfig.server.json" \
  "$PROJECT_ROOT/whatsapp-plugin/index.html" \
  "$PROJECT_ROOT/whatsapp-plugin/vite.config.ts" \
  "$STAGING_DIR/whatsapp-plugin/"
cp "$PROJECT_ROOT/whatsapp-plugin/LICENSES/"*.txt "$STAGING_DIR/whatsapp-plugin/LICENSES/"

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
rsync -a \
  --exclude='tests/' \
  --exclude='*.test.*' \
  "$PROJECT_ROOT/whatsapp-plugin/src/" "$STAGING_DIR/whatsapp-plugin/src/"
rsync -a \
  --exclude='*-test.js' \
  --exclude='*-test.js.map' \
  --exclude='self-test.js' \
  --exclude='self-test.js.map' \
  "$PROJECT_ROOT/backend/dist/" "$STAGING_DIR/backend/dist/"
rsync -a "$PROJECT_ROOT/frontend/dist/" "$STAGING_DIR/frontend/dist/"
rsync -a "$PROJECT_ROOT/whatsapp-plugin/dist/" "$STAGING_DIR/whatsapp-plugin/dist/"
rsync -a "$PROJECT_ROOT/whatsapp-plugin/dist-server/" "$STAGING_DIR/whatsapp-plugin/dist-server/"

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
cp "$PROJECT_ROOT/deploy/baota/deploy-goodjob.sh" "$STAGING_DIR/deploy-goodjob.sh"
cp "$PROJECT_ROOT/deploy/baota/one-click-install.sh" "$STAGING_DIR/one-click-install.sh"
cp "$PROJECT_ROOT/deploy/baota/manage-service.sh" "$STAGING_DIR/manage-service.sh"
cp "$PROJECT_ROOT/deploy/baota/manage-accounts.sh" "$STAGING_DIR/manage-accounts.sh"
cp "$PROJECT_ROOT/deploy/baota/deploy.conf.example" "$STAGING_DIR/deploy.conf.example"
cp "$PROJECT_ROOT/deploy/baota/BAOTA-INSTALL.txt" "$STAGING_DIR/BAOTA-INSTALL.txt"
cp "$PROJECT_ROOT/docs/AI-AGENT-CLOSED-LOOP.md" "$STAGING_DIR/docs/AI-AGENT-CLOSED-LOOP.md"
cp "$PROJECT_ROOT/docs/AI-AGENT-IMPLEMENTATION-PLAN.md" "$STAGING_DIR/docs/AI-AGENT-IMPLEMENTATION-PLAN.md"
cp "$PROJECT_ROOT/docs/DEPLOYMENT-INCIDENT-2026-07.md" "$STAGING_DIR/docs/DEPLOYMENT-INCIDENT-2026-07.md"
cp "$PROJECT_ROOT/docs/AI-AGENT-KNOWLEDGE-LAYER-DEVELOPMENT.md" "$STAGING_DIR/docs/AI-AGENT-KNOWLEDGE-LAYER-DEVELOPMENT.md"
cp "$PROJECT_ROOT/deploy/baota/database/bootstrap.sql.gz" "$STAGING_DIR/database/"
cp "$PROJECT_ROOT/deploy/baota/database/bootstrap.sql.gz.sha256" "$STAGING_DIR/database/"
chmod 0755 \
  "$STAGING_DIR/install-baota.sh" \
  "$STAGING_DIR/deploy-goodjob.sh" \
  "$STAGING_DIR/one-click-install.sh" \
  "$STAGING_DIR/manage-service.sh" \
  "$STAGING_DIR/manage-accounts.sh"

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
grep -Fq 'credentials.length !== 40' "$STAGING_DIR/backend/dist/provision-beta-admins.js" \
  || { printf '安装包缺少 40 个管理员完整性校验\n' >&2; exit 1; }
grep -Fq 'REMOVE_PRIMARY_ADMIN' "$STAGING_DIR/backend/dist/provision-beta-admins.js" \
  || { printf '安装包缺少旧通用管理员删除逻辑\n' >&2; exit 1; }
grep -Fq 'stop_existing_services' "$STAGING_DIR/install-baota.sh" \
  || { printf '安装包缺少旧服务停止逻辑\n' >&2; exit 1; }
grep -Fq 'backend/dist/migrate-mysql.js' "$STAGING_DIR/install-baota.sh" \
  || { printf '安装包缺少 MySQL 增量迁移入口\n' >&2; exit 1; }
grep -Fq 'MYSQL_DATA_IMPORT_TOKEN' "$STAGING_DIR/install-baota.sh" \
  || { printf '安装包缺少 MySQL 文件迁移授权配置\n' >&2; exit 1; }
grep -Fq 'MySQL 数据迁移' "$STAGING_DIR/frontend/dist/index.html" \
  || { printf '安装包缺少 MySQL 文件迁移界面\n' >&2; exit 1; }
if grep -Eq 'mysqldump|before-upgrade-.*sql|restore_database_after_failure|backup_database|reset_database_objects|DROP[[:space:]]+(TABLE|DATABASE)|TRUNCATE[[:space:]]+TABLE' \
  "$STAGING_DIR/install-baota.sh"; then
  printf '安装脚本禁止导出、压缩、恢复或清空业务数据库\n' >&2
  exit 1
fi
grep -Fq 'grep -Fq '"'"'<title>GoodJob CRM'"'"' "$crm_home_file"' \
  "$STAGING_DIR/deploy-goodjob.sh" \
  || { printf '部署验收脚本缺少大页面 SIGPIPE 误判修复\n' >&2; exit 1; }
if grep -Eq '"\$NPM_BIN"[[:space:]]+(ci|prune|run[[:space:]]+(build|db:migrate)).*--prefix' \
  "$STAGING_DIR/install-baota.sh"; then
  printf '安装脚本仍存在不兼容的 npm --prefix 参数顺序\n' >&2
  exit 1
fi
if grep -Fq 'for (index=' "$STAGING_DIR/deploy-goodjob.sh"; then
  printf '部署预检仍使用与 awk 内置函数冲突的变量名 index\n' >&2
  exit 1
fi
if grep -ERq 'ProtectKernelLogs' \
  "$STAGING_DIR/install-baota.sh" "$STAGING_DIR/deploy-goodjob.sh"; then
  printf '部署脚本仍包含旧 systemd 不兼容配置\n' >&2
  exit 1
fi
grep -Fq 'NGINX_BIN=/www/server/nginx/sbin/nginx' "$STAGING_DIR/install-baota.sh" \
  || { printf '安装器没有优先使用宝塔 Nginx\n' >&2; exit 1; }
grep -Fq 'PACKAGE-MANIFEST.sha256' "$STAGING_DIR/install-baota.sh" \
  || { printf '安装器缺少逐文件完整性校验\n' >&2; exit 1; }
grep -Fq 'find_compatible_node' "$STAGING_DIR/deploy-goodjob.sh" \
  || { printf '部署预检缺少 Node.js 22+ 候选选择逻辑\n' >&2; exit 1; }
if grep -ERqi "BEGIN (RSA|OPENSSH|EC|PRIVATE) KEY" "$STAGING_DIR"; then
  printf '打包目录中发现私钥\n' >&2
  exit 1
fi

MANIFEST_PATH="$STAGING_DIR/PACKAGE-MANIFEST.sha256"
(
  cd "$STAGING_DIR"
  find . -type f ! -name 'PACKAGE-MANIFEST.sha256' -print \
    | sed 's#^./##' \
    | LC_ALL=C sort \
    | while IFS= read -r relative_path; do
        if command -v sha256sum >/dev/null 2>&1; then
          digest="$(sha256sum "$relative_path" | awk '{print $1}')"
        else
          digest="$(shasum -a 256 "$relative_path" | awk '{print $1}')"
        fi
        printf '%s  %s\n' "$digest" "$relative_path"
      done
) > "$MANIFEST_PATH"
chmod 0644 "$MANIFEST_PATH"
bash "$STAGING_DIR/install-baota.sh" --check-package

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
