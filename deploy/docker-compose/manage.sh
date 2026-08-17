#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"
load_env
export GOODJOB_RELEASE_ID="$(cat "$STATE_DIR/current-release" 2>/dev/null || release_id)"

action="${1:-status}"
case "$action" in
  status)
    compose ps
    curl --fail --silent --show-error "http://127.0.0.1:${GOODJOB_HTTP_PORT}/api/health" && printf '\n'
    ;;
  logs)
    compose logs --tail "${2:-200}" -f backend communication gateway
    ;;
  restart)
    compose restart backend communication gateway
    ;;
  stop)
    compose stop gateway backend communication
    ;;
  start)
    compose up -d --no-build mysql communication backend gateway
    ;;
  *)
    die "用法：$0 {status|logs [行数]|restart|stop|start}"
    ;;
esac
