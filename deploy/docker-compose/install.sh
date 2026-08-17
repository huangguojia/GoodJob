#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"
load_env
"$SCRIPT_DIR/preflight.sh"

if [[ ! -f "$PACKAGE_ROOT/backend/dist/server.js" || "${GOODJOB_BUILD_BEFORE_INSTALL:-false}" == "true" ]]; then
  log "未检测到可用生产构建，使用 Node.js Docker 构建器生成构建产物"
  "$SCRIPT_DIR/build-in-docker.sh"
fi

legacy_postgres_started=false
current_release=""
new_release=""
cleanup_legacy_postgres() {
  if [[ "$legacy_postgres_started" == true ]]; then
    compose --profile legacy-migration stop postgres >/dev/null 2>&1 || true
    compose --profile legacy-migration rm -f postgres >/dev/null 2>&1 || true
  fi
}
cleanup_install() {
  local exit_code="$?"
  cleanup_legacy_postgres
  if (( exit_code != 0 )); then
    if [[ -n "$current_release" ]]; then
      rm -f "$STATE_DIR/install-intent"
      log "新版本部署失败，尝试恢复上一版应用容器：$current_release"
      export GOODJOB_RELEASE_ID="$current_release"
      compose up -d --no-build backend communication gateway >/dev/null 2>&1 || true
      if wait_for_url "http://127.0.0.1:${GOODJOB_HTTP_PORT}/api/health" 30; then
        log "上一版应用容器已恢复；数据库迁移不会自动回滚，请根据备份评估"
      else
        warn "上一版应用容器自动恢复失败，请执行 ./rollback.sh 并查看 ./manage.sh logs 200"
      fi
    elif [[ -n "$new_release" ]]; then
      printf '%s\n' "$new_release" > "$STATE_DIR/install-intent"
      chmod 0600 "$STATE_DIR/install-intent"
      warn "首次安装未完成，已保留重试标记；修复问题后重新执行更新命令"
    fi
  fi
  exit "$exit_code"
}
trap cleanup_install EXIT

new_release="$(release_id)"
export GOODJOB_RELEASE_ID="$new_release"
current_release="$(cat "$STATE_DIR/current-release" 2>/dev/null || true)"
install_intent="$(cat "$STATE_DIR/install-intent" 2>/dev/null || true)"
if [[ -n "$install_intent" && "$install_intent" != "$new_release" ]]; then
  warn "清理上次未完成的部署标记：$install_intent"
  rm -f "$STATE_DIR/install-intent"
fi
printf '%s\n' "$new_release" > "$STATE_DIR/install-intent"
chmod 0600 "$STATE_DIR/install-intent"

if [[ -n "$current_release" ]]; then
  log "升级前备份当前统一 MySQL"
  "$SCRIPT_DIR/backup.sh"
fi

log "构建 GoodJob $new_release 镜像（不会重启 Docker daemon）"
COMPOSE_PARALLEL_LIMIT=1 compose --profile tools build backend-migrate communication-migrate gateway

legacy_postgres_volume=false
if docker volume inspect goodjobcrm_postgres_data >/dev/null 2>&1; then
  legacy_postgres_volume=true
fi

log "启动统一 MySQL 8"
compose up -d mysql

log "执行幂等数据库迁移"
compose --profile tools run --rm backend-migrate
compose --profile tools run --rm communication-migrate

if [[ "$legacy_postgres_volume" == true ]]; then
  migration_complete="$(compose exec -T mysql sh -ec \
    'MYSQL_PWD="$(cat /run/secrets/mysql_root_password)" mysql -u root -N -B "$MYSQL_DATABASE" -e "SELECT COUNT(*) FROM communication_data_migrations WHERE id='\''postgres-to-mysql-v1'\'';"' \
    2>/dev/null || printf '0')"
  log "检测到旧 Communication PostgreSQL 卷，启动只读校验窗口"
  compose --profile legacy-migration up -d --wait postgres
  legacy_postgres_started=true
  if [[ "$migration_complete" != "1" ]]; then
    log "首次把旧 Communication PostgreSQL 数据迁移到统一 MySQL"
    legacy_backup_dir="$BACKUP_DIR/legacy-postgres-$(date +%Y%m%d-%H%M%S)"
    install -d -m 0700 "$legacy_backup_dir"
    compose --profile legacy-migration exec -T postgres sh -ec \
      'PGPASSWORD="$(cat /run/secrets/postgres_password)" exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
      > "$legacy_backup_dir/postgres.dump"
    sha256sum "$legacy_backup_dir/postgres.dump" > "$legacy_backup_dir/SHA256SUMS"
    log "旧 PostgreSQL 迁移前快照：$legacy_backup_dir/postgres.dump"
    compose --profile tools --profile legacy-migration run --rm \
      -e MIGRATE_FROM_POSTGRES=true \
      communication-migrate \
      node dist-server/server/scripts/migrate-postgres-to-mysql.js --apply
    log "旧 PostgreSQL 数据迁移及逐表校验通过"
  else
    log "迁移标记已存在，重新核对旧 PostgreSQL 指纹与统一 MySQL 全量内容"
    compose --profile tools --profile legacy-migration run --rm \
      -e MIGRATE_FROM_POSTGRES=true \
      communication-migrate \
      node dist-server/server/scripts/migrate-postgres-to-mysql.js --verify-only
    log "已完成迁移重试核验，未重写任何数据"
  fi
  cleanup_legacy_postgres
  legacy_postgres_started=false
  warn "旧 PostgreSQL 数据卷 goodjobcrm_postgres_data 已停用但未删除，可用于人工回滚"
fi

log "启动应用容器"
compose up -d --no-build backend communication gateway
if ! wait_for_url "http://127.0.0.1:${GOODJOB_HTTP_PORT}/api/health" 60; then
  compose ps
  compose logs --tail 120 backend communication gateway >&2 || true
  die "应用在 120 秒内未通过健康检查；数据库卷未删除"
fi

if [[ -n "$current_release" && "$current_release" != "$new_release" ]]; then
  printf '%s\n' "$current_release" > "$STATE_DIR/previous-release"
fi
printf '%s\n' "$new_release" > "$STATE_DIR/current-release"
rm -f "$STATE_DIR/install-intent"
chmod 0600 "$STATE_DIR"/*

log "清理旧应用镜像，仅保留当前版和上一版"
for repository in goodjobcrm-backend goodjobcrm-communication goodjobcrm-gateway; do
  while IFS= read -r image_ref; do
    [[ -n "$image_ref" ]] || continue
    image_tag="${image_ref##*:}"
    if [[ "$image_tag" != "$new_release" && "$image_tag" != "$current_release" ]]; then
      docker image rm "$image_ref" >/dev/null 2>&1 \
        || warn "旧镜像仍被占用，暂未清理：$image_ref"
    fi
  done < <(docker image ls "$repository" --format '{{.Repository}}:{{.Tag}}')
done

log "容器部署完成：http://127.0.0.1:${GOODJOB_HTTP_PORT}"
log "下一步按 DOCKER-BAOTA-INSTALL.md 给 GoodJob 专属宝塔网站添加反向代理"
