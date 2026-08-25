#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

BACKEND_IMAGE="${GOODJOB_BACKEND_IMAGE:-crpi-f1g4pi9vyexdaer5.cn-hongkong.personal.cr.aliyuncs.com/kevin_goodjobcrm/backend}"
GATEWAY_IMAGE="${GOODJOB_GATEWAY_IMAGE:-crpi-f1g4pi9vyexdaer5.cn-hongkong.personal.cr.aliyuncs.com/kevin_goodjobcrm/gateway}"
COMMUNICATION_IMAGE="${GOODJOB_COMMUNICATION_IMAGE:-crpi-f1g4pi9vyexdaer5.cn-hongkong.personal.cr.aliyuncs.com/kevin_goodjobcrm/communication}"
VERSION="${1:-${GOODJOB_RELEASE_ID:-}}"

die() { printf '[GoodJob 镜像发布][错误] %s\n' "$*" >&2; exit 1; }
log() { printf '[GoodJob 镜像发布] %s\n' "$*"; }

[[ -n "$VERSION" ]] || die "请提供固定版本号，例如：$0 1.5.8"
[[ "$VERSION" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || die "版本号只能包含字母、数字、点、下划线和连字符：$VERSION"
for image in "$BACKEND_IMAGE" "$GATEWAY_IMAGE" "$COMMUNICATION_IMAGE"; do
  [[ "$image" != *:* && "$image" != *@* && "$image" != *[[:space:]]* ]] \
    || die "镜像仓库地址不能带标签、digest 或空格：$image"
done

command -v docker >/dev/null 2>&1 || die "缺少 Docker"
docker info >/dev/null 2>&1 || die "Docker daemon 不可用，请先启动 Docker Desktop"
docker buildx inspect --bootstrap >/dev/null 2>&1 || die "Buildx 不可用"
[[ -f "$PACKAGE_ROOT/.dockerignore" ]] || die "缺少 .dockerignore，拒绝发布以避免把本地数据带入构建上下文"

log "使用 linux/amd64 构建；服务器架构为 x86_64"
log "先生成干净的生产构建产物"
(cd "$PACKAGE_ROOT" && "$SCRIPT_DIR/build-in-docker.sh")

build_and_push() {
  local image="$1" dockerfile="$2"
  log "构建并推送 $image:$VERSION"
  docker buildx build \
    --pull=false \
    --provenance=false \
    --sbom=false \
    --platform linux/amd64 \
    --file "$PACKAGE_ROOT/$dockerfile" \
    --tag "$image:$VERSION" \
    --push \
    "$PACKAGE_ROOT"
}

build_and_push "$BACKEND_IMAGE" deploy/docker-compose/Dockerfile.backend
build_and_push "$COMMUNICATION_IMAGE" deploy/docker-compose/Dockerfile.communication
build_and_push "$GATEWAY_IMAGE" deploy/docker-compose/Dockerfile.gateway

log "三个 linux/amd64 镜像已推送完成：$VERSION"
log "服务器更新命令：./update-registry.sh $VERSION"
