#!/usr/bin/env bash
set -Eeuo pipefail

PACKAGE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
COMMAND="$(basename -- "$0")"
TARGET="$PACKAGE_ROOT/deploy/docker-compose/$COMMAND"
[[ -x "$TARGET" ]] || { printf '部署命令不存在：%s\n' "$TARGET" >&2; exit 1; }
exec "$TARGET" "$@"
