#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE_NAME="${SERVICE_NAME:-goodjob-crm}"
WHATSAPP_PLUGIN_SERVICE_NAME="${WHATSAPP_PLUGIN_SERVICE_NAME:-goodjob-crm-whatsapp}"
BACKEND_PORT="${BACKEND_PORT:-4188}"
WHATSAPP_PLUGIN_PORT="${WHATSAPP_PLUGIN_PORT:-3100}"
ACTION="${1:-status}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    printf '请使用 sudo bash %s %s\n' "$0" "$ACTION" >&2
    exit 1
  fi
}

wait_for_health() {
  local attempt=0
  for attempt in {1..30}; do
    if curl -fsS "http://127.0.0.1:$BACKEND_PORT/api/health" 2>/dev/null \
      | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'; then
      printf '\nGoodJob CRM 服务健康，后端端口：%s\n' "$BACKEND_PORT"
      return 0
    fi
    sleep 1
  done
  printf '服务未在 30 秒内通过健康检查。\n' >&2
  systemctl status "$SERVICE_NAME" --no-pager || true
  return 1
}

wait_for_plugin_health() {
  local attempt=0
  for attempt in {1..30}; do
    if curl -fsS "http://127.0.0.1:$WHATSAPP_PLUGIN_PORT/api/health" 2>/dev/null \
      | grep -Eq '"ready"[[:space:]]*:[[:space:]]*true'; then
      printf '\nWhatsApp 插件服务健康，后端端口：%s\n' "$WHATSAPP_PLUGIN_PORT"
      return 0
    fi
    sleep 1
  done
  printf 'WhatsApp 插件服务未在 30 秒内通过健康检查。\n' >&2
  systemctl status "$WHATSAPP_PLUGIN_SERVICE_NAME" --no-pager || true
  return 1
}

case "$ACTION" in
  start)
    require_root
    systemctl enable --now "$SERVICE_NAME"
    systemctl enable --now "$WHATSAPP_PLUGIN_SERVICE_NAME"
    wait_for_health
    wait_for_plugin_health
    ;;
  stop)
    require_root
    systemctl stop "$SERVICE_NAME"
    systemctl stop "$WHATSAPP_PLUGIN_SERVICE_NAME"
    ;;
  restart)
    require_root
    systemctl restart "$SERVICE_NAME"
    systemctl restart "$WHATSAPP_PLUGIN_SERVICE_NAME"
    wait_for_health
    wait_for_plugin_health
    ;;
  status)
    systemctl status "$SERVICE_NAME" --no-pager
    systemctl status "$WHATSAPP_PLUGIN_SERVICE_NAME" --no-pager
    ;;
  logs)
    require_root
    journalctl -u "$SERVICE_NAME" -u "$WHATSAPP_PLUGIN_SERVICE_NAME" -f
    ;;
  health)
    curl -fsS "http://127.0.0.1:$BACKEND_PORT/api/health"
    printf '\n'
    curl -fsS "http://127.0.0.1:$WHATSAPP_PLUGIN_PORT/api/health"
    printf '\n'
    ;;
  verify|doctor)
    require_root
    exec bash "$SCRIPT_DIR/deploy-goodjob.sh" --verify-only
    ;;
  *)
    printf '用法：bash %s {start|stop|restart|status|logs|health|verify}\n' "$0" >&2
    exit 2
    ;;
esac
