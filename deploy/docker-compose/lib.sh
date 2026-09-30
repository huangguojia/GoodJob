#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_ROOT="${GOODJOB_APP_ROOT:-/opt/goodjobcrm}"
SHARED_DIR="$APP_ROOT/shared"
ENV_FILE="$SHARED_DIR/deploy.env"
SECRETS_DIR="$SHARED_DIR/secrets"
STATE_DIR="$SHARED_DIR/state"
BACKUP_DIR="$SHARED_DIR/backups"
COMPOSE_FILE="$PACKAGE_ROOT/deploy/docker-compose/compose.yml"

log() { printf '[GoodJob] %s\n' "$*"; }
warn() { printf '[GoodJob][警告] %s\n' "$*" >&2; }
die() { printf '[GoodJob][错误] %s\n' "$*" >&2; exit 1; }

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "缺少命令：$1"
}

load_env() {
  [[ -f "$ENV_FILE" ]] || die "尚未配置，请先运行 ./configure.sh"
  set -a
  # deploy.env 由 configure.sh 生成，只允许 root 写入。
  source "$ENV_FILE"
  set +a
  export GOODJOB_SHARED_DIR="$SHARED_DIR"
}

compose() {
  docker compose --project-name goodjobcrm --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

release_id() {
  if [[ -n "${GOODJOB_RELEASE_ID:-}" ]]; then
    printf '%s\n' "$GOODJOB_RELEASE_ID"
    return
  fi
  if [[ -f "$PACKAGE_ROOT/RELEASE-ID" ]]; then
    tr -d '\r\n' < "$PACKAGE_ROOT/RELEASE-ID"
  else
    printf 'manual-%s' "$(date +%Y%m%d%H%M%S)"
  fi
}

image_mode() {
  printf '%s\n' "${GOODJOB_IMAGE_MODE:-local}"
}

image_repository() {
  case "$1" in
    backend) printf '%s\n' "${GOODJOB_BACKEND_IMAGE:-goodjobcrm-backend}" ;;
    communication) printf '%s\n' "${GOODJOB_COMMUNICATION_IMAGE:-goodjobcrm-communication}" ;;
    gateway) printf '%s\n' "${GOODJOB_GATEWAY_IMAGE:-goodjobcrm-gateway}" ;;
    *) die "未知 GoodJob 镜像服务：$1" ;;
  esac
}

validate_image_mode() {
  case "$(image_mode)" in
    local)
      ;;
    registry)
      local service repository
      for service in backend communication gateway; do
        repository="$(image_repository "$service")"
        [[ "$repository" != *[[:space:]]* && "$repository" != *:* && "$repository" != *@* ]] \
          || die "registry 模式的 $service 镜像仓库地址不能包含空格、标签或 digest：$repository"
        [[ "$repository" == */* ]] \
          || die "registry 模式的 $service 必须使用完整镜像仓库地址：$repository"
      done
      ;;
    *)
      die "GOODJOB_IMAGE_MODE 只能是 local 或 registry，当前为：$(image_mode)"
      ;;
  esac
}

secret_value() {
  local file="$SECRETS_DIR/$1"
  [[ -s "$file" ]] || die "Secret 不存在或为空：$file"
  cat "$file"
}

wait_for_url() {
  local url="$1"
  local attempts="${2:-60}"
  local index
  for ((index=1; index<=attempts; index+=1)); do
    if curl --fail --silent --show-error --max-time 5 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}
