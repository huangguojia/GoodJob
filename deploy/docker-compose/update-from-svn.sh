#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_SOURCE_ROOT="${GOODJOB_SOURCE_ROOT:-/opt/goodjobcrm-src}"
SOURCE_ROOT="$DEFAULT_SOURCE_ROOT"
SVN_URL="${GOODJOB_SVN_URL:-svn://gitee.com/sendoh-huang/good-job-private}"
APP_ROOT="${GOODJOB_APP_ROOT:-/opt/goodjobcrm}"

log() { printf '[GoodJob 更新] %s\n' "$*"; }
die() { printf '[GoodJob 更新][错误] %s\n' "$*" >&2; exit 1; }

[[ "${EUID:-$(id -u)}" -eq 0 ]] || die "请使用 root 执行"
command -v svn >/dev/null 2>&1 || die "缺少 svn，请先安装 Subversion"
command -v docker >/dev/null 2>&1 || die "缺少 Docker，请先安装 Docker Engine"

if [[ ! -e "$SOURCE_ROOT" ]]; then
  log "首次拉取私人仓库：$SVN_URL"
  install -d -m 0750 "$(dirname "$SOURCE_ROOT")"
  svn checkout "$SVN_URL" "$SOURCE_ROOT"
elif [[ ! -d "$SOURCE_ROOT/.svn" ]]; then
  die "$SOURCE_ROOT 已存在但不是 SVN 工作副本；为避免覆盖文件，已停止"
else
  # Communication 的 dist-server 是版本化构建产物，服务器本地构建后恢复到仓库状态。
  svn revert -R "$SOURCE_ROOT/whatsapp-plugin/dist-server" >/dev/null 2>&1 || true
  dirty=""
  while IFS= read -r status_line; do
    [[ -n "$status_line" ]] || continue
    status_code="${status_line:0:1}"
    status_path="${status_line:8}"
    if [[ "$status_code" == "?" ]]; then
      case "$status_path" in
        node_modules|node_modules/*|\
        backend/dist|backend/dist/*|backend/node_modules|backend/node_modules/*|backend/uploads|backend/uploads/*|\
        frontend/dist|frontend/dist/*|frontend/node_modules|frontend/node_modules/*|frontend/tsconfig.tsbuildinfo|\
        integration-sdk/dist|integration-sdk/dist/*|integration-worker/dist|integration-worker/dist/*|integration-worker/node_modules|integration-worker/node_modules/*|\
        whatsapp-plugin/dist|whatsapp-plugin/dist/*|whatsapp-plugin/dist-server|whatsapp-plugin/dist-server/*|whatsapp-plugin/node_modules|whatsapp-plugin/node_modules/*|whatsapp-plugin/.data|whatsapp-plugin/.data/*|\
        dist-packages|dist-packages/*)
          continue
          ;;
      esac
    fi
    dirty+="$status_line\n"
  done < <(cd "$SOURCE_ROOT" && svn status)
  [[ -z "$dirty" ]] || die "源码工作副本有未提交修改，请先处理：\n$dirty"
  log "拉取私人仓库最新提交"
  svn update "$SOURCE_ROOT"
fi

[[ -f "$SOURCE_ROOT/deploy/docker-compose/update-from-svn.sh" ]] \
  || die "仓库缺少更新脚本，无法继续"

DEPLOY_DIR="$SOURCE_ROOT/deploy/docker-compose"

if [[ ! -f "$APP_ROOT/shared/deploy.env" ]]; then
  log "首次部署，开始配置域名和超级管理员"
  (cd "$SOURCE_ROOT" && "$DEPLOY_DIR/configure.sh")
fi

version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SOURCE_ROOT/frontend/public/product-config.json" | head -n 1)"
[[ -n "$version" ]] || version="source"
release="${version}-$(date +%Y%m%d%H%M%S)"

log "构建版本 $release"
(cd "$SOURCE_ROOT" && "$DEPLOY_DIR/build-in-docker.sh")
log "执行数据库备份、迁移和健康检查"
(cd "$SOURCE_ROOT" && GOODJOB_BUILD_BEFORE_INSTALL=false GOODJOB_RELEASE_ID="$release" "$DEPLOY_DIR/install.sh")
svn revert -R "$SOURCE_ROOT/whatsapp-plugin/dist-server" >/dev/null 2>&1 || true
log "更新完成。当前访问地址见 shared/deploy.env 的 PUBLIC_ORIGIN"
