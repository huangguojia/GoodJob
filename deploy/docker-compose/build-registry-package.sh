#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VERSION="${1:-}"
OUTPUT_DIR="${2:-$PROJECT_ROOT/dist-packages}"

die() { printf '[GoodJob 部署包][错误] %s\n' "$*" >&2; exit 1; }
log() { printf '[GoodJob 部署包] %s\n' "$*"; }

[[ "$VERSION" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] \
  || die "请提供固定版本号，例如：$0 1.5.9"
command -v rsync >/dev/null 2>&1 || die "缺少 rsync"
command -v shasum >/dev/null 2>&1 || die "缺少 shasum"

PACKAGE_NAME="GoodJob-CRM-Registry-$VERSION"
STAGING_ROOT="$(mktemp -d)"
STAGING_DIR="$STAGING_ROOT/$PACKAGE_NAME"
ARCHIVE_PATH="$OUTPUT_DIR/$PACKAGE_NAME.tar.gz"
trap 'rm -rf "$STAGING_ROOT"' EXIT

install -d "$OUTPUT_DIR" "$STAGING_DIR/deploy/docker-compose"
rsync -a \
  --exclude 'build-package.sh' \
  --exclude 'build-registry-package.sh' \
  --exclude 'publish-images.sh' \
  --exclude 'update-from-svn.sh' \
  --exclude 'update-docker.sh' \
  "$SCRIPT_DIR/" "$STAGING_DIR/deploy/docker-compose/"

for command in configure.sh preflight.sh install.sh backup.sh restore.sh manage.sh rollback.sh update-registry.sh; do
  cp "$SCRIPT_DIR/root-command.sh" "$STAGING_DIR/$command"
  chmod 0755 "$STAGING_DIR/$command"
done
cp "$SCRIPT_DIR/DOCKER-BAOTA-INSTALL.md" "$STAGING_DIR/DOCKER-BAOTA-INSTALL.md"
printf '%s\n' "$VERSION" > "$STAGING_DIR/RELEASE-ID"

if find "$STAGING_DIR" -type f \( -name '.env' -o -name 'deploy.env' -o -path '*/secrets/*' \) -print -quit | grep -q .; then
  die "部署包中发现生产配置或 secret"
fi
if find "$STAGING_DIR" -type d \( -name backend -o -name frontend -o -name node_modules -o -name uploads \) -print -quit | grep -q .; then
  die "部署包中发现源码、依赖或上传目录"
fi

(cd "$STAGING_DIR" && find . -type f ! -name PACKAGE-MANIFEST.sha256 -print \
  | sed 's#^./##' | LC_ALL=C sort \
  | while IFS= read -r file; do shasum -a 256 "$file"; done) \
  > "$STAGING_DIR/PACKAGE-MANIFEST.sha256"

(cd "$STAGING_DIR" && shasum -a 256 -c PACKAGE-MANIFEST.sha256 >/dev/null) \
  || die "部署包逐文件校验失败"

tar -C "$STAGING_ROOT" -czf "$ARCHIVE_PATH" "$PACKAGE_NAME"
chmod 0600 "$ARCHIVE_PATH"
(cd "$OUTPUT_DIR" && shasum -a 256 "$(basename "$ARCHIVE_PATH")") \
  > "$ARCHIVE_PATH.sha256"
chmod 0600 "$ARCHIVE_PATH.sha256"

log "已生成：$ARCHIVE_PATH"
log "校验文件：$ARCHIVE_PATH.sha256"
