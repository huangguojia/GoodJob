#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

log() { printf '[GoodJob] %s\n' "$*"; }
die() { printf '[GoodJob][错误] %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "缺少 Docker；请先安装 Docker Engine"
[[ -f "$PACKAGE_ROOT/package.json" && -f "$PACKAGE_ROOT/package-lock.json" ]] \
  || die "当前目录不是完整 GoodJob 源码目录"

log "在临时 Node.js 22 构建容器内安装依赖并编译，宿主机不需要安装 Node.js"
docker run --rm \
  --user 0:0 \
  --volume "$PACKAGE_ROOT:/workspace" \
  --workdir /workspace \
  --env NPM_CONFIG_UPDATE_NOTIFIER=false \
  --env NPM_CONFIG_FUND=false \
  node:22-bookworm-slim \
  sh -ec 'npm ci --no-audit --no-fund && npm --prefix whatsapp-plugin ci --no-audit --no-fund && npm run build'

for required in \
  backend/dist/server.js \
  backend/dist/migrate-mysql.js \
  backend/resources/document-templates/proforma-invoice-variable-base.xlsx \
  frontend/dist/index.html \
  whatsapp-plugin/dist/index.html \
  whatsapp-plugin/dist-server/server/index.js; do
  [[ -f "$PACKAGE_ROOT/$required" ]] || die "构建完成但缺少：$required"
done

log "生产构建完成"
