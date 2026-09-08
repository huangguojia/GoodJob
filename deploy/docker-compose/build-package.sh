#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUTPUT_DIR="${1:-$PROJECT_ROOT/dist-packages}"
TIMESTAMP="${PACKAGE_TIMESTAMP:-$(date +%Y%m%d-%H%M%S)}"
PACKAGE_NAME="GoodJob-CRM-Docker-$TIMESTAMP"
PRODUCT_VERSION="$(node -e 'try { process.stdout.write(require(process.argv[1]).version || "unknown") } catch { process.stdout.write("unknown") }' "$PROJECT_ROOT/frontend/public/product-config.json")"
RELEASE_ID="${GOODJOB_RELEASE_ID:-${PRODUCT_VERSION}-$TIMESTAMP}"
STAGING_ROOT="$(mktemp -d)"
STAGING_DIR="$STAGING_ROOT/$PACKAGE_NAME"
ARCHIVE_PATH="$OUTPUT_DIR/$PACKAGE_NAME.tar.gz"
trap 'rm -rf "$STAGING_ROOT"' EXIT

command -v rsync >/dev/null 2>&1 || { printf '缺少 rsync\n' >&2; exit 1; }
printf '执行 CRM、前端和 Communication 生产构建...\n'
npm --prefix "$PROJECT_ROOT" run build

for required in \
  backend/dist/server.js \
  backend/dist/migrate-mysql.js \
  frontend/dist/index.html \
  whatsapp-plugin/dist/index.html \
  whatsapp-plugin/dist-server/server/index.js \
  whatsapp-plugin/dist-server/server/scripts/migrate.js \
  whatsapp-plugin/dist-server/server/scripts/migrate-postgres-to-mysql.js; do
  [[ -f "$PROJECT_ROOT/$required" ]] || { printf '缺少构建产物：%s\n' "$required" >&2; exit 1; }
done

install -d "$OUTPUT_DIR" "$STAGING_DIR/backend" "$STAGING_DIR/frontend" \
  "$STAGING_DIR/whatsapp-plugin" "$STAGING_DIR/integration-sdk" \
  "$STAGING_DIR/integration-worker" "$STAGING_DIR/deploy"
cp "$PROJECT_ROOT/package.json" "$PROJECT_ROOT/package-lock.json" "$STAGING_DIR/"
cp "$PROJECT_ROOT/backend/package.json" "$STAGING_DIR/backend/"
cp "$PROJECT_ROOT/frontend/package.json" "$STAGING_DIR/frontend/"
cp "$PROJECT_ROOT/integration-sdk/package.json" "$STAGING_DIR/integration-sdk/"
cp "$PROJECT_ROOT/integration-worker/package.json" "$STAGING_DIR/integration-worker/"
cp "$PROJECT_ROOT/whatsapp-plugin/package.json" \
  "$PROJECT_ROOT/whatsapp-plugin/package-lock.json" "$STAGING_DIR/whatsapp-plugin/"
rsync -a "$PROJECT_ROOT/backend/dist/" "$STAGING_DIR/backend/dist/"
rsync -a "$PROJECT_ROOT/backend/resources/" "$STAGING_DIR/backend/resources/"
rsync -a "$PROJECT_ROOT/integration-sdk/dist/" "$STAGING_DIR/integration-sdk/dist/"
rsync -a "$PROJECT_ROOT/frontend/dist/" "$STAGING_DIR/frontend/dist/"
rsync -a "$PROJECT_ROOT/whatsapp-plugin/dist/" "$STAGING_DIR/whatsapp-plugin/dist/"
rsync -a "$PROJECT_ROOT/whatsapp-plugin/dist-server/" "$STAGING_DIR/whatsapp-plugin/dist-server/"
rsync -a "$PROJECT_ROOT/agent-knowledge/" "$STAGING_DIR/agent-knowledge/"
rsync -a "$PROJECT_ROOT/agent-skills/" "$STAGING_DIR/agent-skills/"
rsync -a "$PROJECT_ROOT/deploy/docker-compose/" "$STAGING_DIR/deploy/docker-compose/"
cp "$PROJECT_ROOT/LICENSE" "$PROJECT_ROOT/NOTICE" "$PROJECT_ROOT/README.md" "$STAGING_DIR/"
printf '%s\n' "$RELEASE_ID" > "$STAGING_DIR/RELEASE-ID"

for script in configure.sh preflight.sh install.sh backup.sh restore.sh manage.sh rollback.sh update-docker.sh; do
  cp "$STAGING_DIR/deploy/docker-compose/root-command.sh" "$STAGING_DIR/$script"
  chmod 0755 "$STAGING_DIR/$script"
done
cp "$STAGING_DIR/deploy/docker-compose/install-docker-ubuntu.sh" "$STAGING_DIR/install-docker-ubuntu.sh"
chmod 0755 "$STAGING_DIR/install-docker-ubuntu.sh"
cp "$STAGING_DIR/deploy/docker-compose/DOCKER-BAOTA-INSTALL.md" "$STAGING_DIR/DOCKER-BAOTA-INSTALL.md"
cp "$PROJECT_ROOT/.dockerignore" "$STAGING_DIR/.dockerignore"

if find "$STAGING_DIR" -type f \( -name '.env' -o -name 'deploy.env' -o -path '*/secrets/*' \) -print -quit | grep -q .; then
  printf '安装包中发现生产配置或 secret\n' >&2
  exit 1
fi
if grep -ERqi 'BEGIN (RSA|OPENSSH|EC|PRIVATE) KEY' "$STAGING_DIR"; then
  printf '安装包中发现私钥\n' >&2
  exit 1
fi

(cd "$STAGING_DIR" && find . -type f ! -name PACKAGE-MANIFEST.sha256 -print \
  | sed 's#^./##' | LC_ALL=C sort \
  | while IFS= read -r file; do shasum -a 256 "$file"; done) \
  > "$STAGING_DIR/PACKAGE-MANIFEST.sha256"

(cd "$STAGING_DIR" && shasum -a 256 -c PACKAGE-MANIFEST.sha256 >/dev/null) \
  || { printf '安装包逐文件校验失败\n' >&2; exit 1; }

tar -C "$STAGING_ROOT" -czf "$ARCHIVE_PATH" "$PACKAGE_NAME"
chmod 0600 "$ARCHIVE_PATH"
(cd "$OUTPUT_DIR" && shasum -a 256 "$(basename "$ARCHIVE_PATH")") \
  > "$ARCHIVE_PATH.sha256"
chmod 0600 "$ARCHIVE_PATH.sha256"
printf '%s\n' "$ARCHIVE_PATH"
