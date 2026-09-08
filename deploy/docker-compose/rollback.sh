#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"
load_env

previous="$(cat "$STATE_DIR/previous-release" 2>/dev/null || true)"
current="$(cat "$STATE_DIR/current-release" 2>/dev/null || true)"
[[ -n "$previous" && -n "$current" ]] || die "没有可回滚的上一版本记录"

export GOODJOB_RELEASE_ID="$previous"
for image in backend communication gateway; do
  docker image inspect "goodjobcrm-$image:$previous" >/dev/null 2>&1 \
    || die "上一版本镜像不存在：goodjobcrm-$image:$previous"
done

warn "本操作只回滚应用镜像，不反向执行数据库迁移"
read -r -p "输入上一版本号 $previous 继续：" confirmation
[[ "$confirmation" == "$previous" ]] || die "已取消"

compose up -d --no-build backend communication gateway
wait_for_url "http://127.0.0.1:${GOODJOB_HTTP_PORT}/api/health" 60 \
  || die "回滚镜像未通过健康检查"
printf '%s\n' "$current" > "$STATE_DIR/previous-release"
printf '%s\n' "$previous" > "$STATE_DIR/current-release"
log "已回滚至 $previous"
