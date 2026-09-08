#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

load_env
require_command docker
require_command curl
require_command ss
require_command sha256sum

log "校验部署包完整性"
if [[ -f "$PACKAGE_ROOT/PACKAGE-MANIFEST.sha256" ]]; then
  (cd "$PACKAGE_ROOT" && sha256sum -c PACKAGE-MANIFEST.sha256 >/dev/null) \
    || die "安装包文件完整性校验失败，请重新上传并解压"
else
  [[ -f "$PACKAGE_ROOT/package.json" && -f "$PACKAGE_ROOT/backend/package.json" ]] \
    || die "当前目录既不是完整安装包，也不是可构建的 SVN 源码目录"
  log "检测到 SVN 源码部署模式；跳过压缩包清单校验"
fi

log "检查 Docker 与 Compose"
docker info >/dev/null 2>&1 || die "Docker daemon 不可用"
docker compose version || die "需要 Docker Compose v2（docker compose）"

compose_major="$(docker compose version --short 2>/dev/null | sed -E 's/^v?([0-9]+).*/\1/')"
[[ "$compose_major" =~ ^[0-9]+$ ]] && (( compose_major >= 2 )) \
  || die "Docker Compose 版本过低"

log "检查磁盘与内存"
available_kb="$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)"
(( available_kb >= 2097152 )) || die "可用内存不足 2 GiB，暂不建议启动 GoodJob"
available_disk_kb="$(df -Pk "$APP_ROOT" 2>/dev/null | awk 'NR==2 {print $4}')"
if [[ -z "$available_disk_kb" ]]; then
  available_disk_kb="$(df -Pk /opt | awk 'NR==2 {print $4}')"
fi
(( available_disk_kb >= 10485760 )) || die "可用磁盘不足 10 GiB"
if [[ "$(awk '/SwapTotal:/ {print $2}' /proc/meminfo)" == "0" ]]; then
  warn "服务器没有 Swap；不会阻止安装，但其他服务突发占用内存时更容易触发 OOM"
fi

log "检查唯一宿主机端口 127.0.0.1:${GOODJOB_HTTP_PORT}"
if ss -lntH "sport = :$GOODJOB_HTTP_PORT" | grep -q .; then
  if ! docker ps --filter label=com.docker.compose.project=goodjobcrm --format '{{.Names}}' \
    | grep -q '^goodjobcrm-gateway-'; then
    ss -lntp "sport = :$GOODJOB_HTTP_PORT" || true
    die "端口 $GOODJOB_HTTP_PORT 已被非 GoodJob 服务占用"
  fi
  log "检测到现有 GoodJob gateway，按升级场景继续"
fi

log "检查 Compose 项目边界"
foreign="$(docker ps -a --filter name='^/goodjobcrm-' --format '{{.Names}} {{.Label "com.docker.compose.project"}}' \
  | awk '$2 != "goodjobcrm" {print}')"
[[ -z "$foreign" ]] || die "发现名称相近但不属于 GoodJob Compose 的容器：$foreign"
existing_goodjob_volume=false
for resource in \
  goodjobcrm_mysql_data \
  goodjobcrm_postgres_data \
  goodjobcrm_communication_media \
  goodjobcrm_uploads_data; do
  if docker volume inspect "$resource" >/dev/null 2>&1; then
    existing_goodjob_volume=true
    owner="$(docker volume inspect --format '{{index .Labels "com.docker.compose.project"}}' "$resource")"
    [[ "$owner" == "goodjobcrm" ]] \
      || die "数据卷 $resource 已存在但不属于 GoodJob Compose，拒绝复用"
  fi
done
if [[ "$existing_goodjob_volume" == true \
  && ! -s "$STATE_DIR/current-release" \
  && ! -s "$STATE_DIR/install-intent" ]]; then
  die "发现 GoodJob 数据卷但没有当前版本状态。请先核对是否为遗留生产数据，禁止按首次安装继续"
fi
if docker network inspect goodjobcrm_private >/dev/null 2>&1; then
  owner="$(docker network inspect --format '{{index .Labels "com.docker.compose.project"}}' goodjobcrm_private)"
  [[ "$owner" == "goodjobcrm" ]] \
    || die "网络 goodjobcrm_private 已存在但不属于 GoodJob Compose，拒绝复用"
fi

log "校验 Compose 配置"
export GOODJOB_RELEASE_ID="$(release_id)"
compose --profile tools config --quiet

log "检查现有服务状态（只读）"
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
log "预检通过。只会新增 goodjobcrm 项目的容器、网络、卷，以及 127.0.0.1:${GOODJOB_HTTP_PORT} 监听"
