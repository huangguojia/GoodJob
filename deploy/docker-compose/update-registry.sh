#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"
load_env
validate_image_mode
[[ "$(image_mode)" == "registry" ]] || die "当前不是 registry 模式，请检查 $ENV_FILE"

release="${1:-${GOODJOB_RELEASE_ID:-}}"
[[ "$release" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] \
  || die "请提供固定版本号，例如：$0 1.5.8"
export GOODJOB_RELEASE_ID="$release"

"$SCRIPT_DIR/preflight.sh"
"$SCRIPT_DIR/install.sh"
