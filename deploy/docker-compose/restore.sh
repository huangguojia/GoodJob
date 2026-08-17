#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"
load_env

target="${1:-}"
[[ -n "$target" && -d "$target" ]] || die "用法：$0 /opt/goodjobcrm/shared/backups/时间戳"
target="$(cd "$target" && pwd)"
[[ "$target" == "$BACKUP_DIR/"* ]] || die "只允许恢复 GoodJob 备份目录中的备份"
[[ -s "$target/mysql.sql.gz" ]] || die "备份不完整，缺少统一 MySQL 备份 mysql.sql.gz"
[[ -s "$target/uploads.tar.gz" ]] || die "备份不完整，缺少上传文件备份 uploads.tar.gz"
[[ -s "$target/communication-media.tar.gz" ]] || die "备份不完整，缺少 Communication 媒体备份 communication-media.tar.gz"
[[ -s "$target/SHA256SUMS" ]] || die "备份不完整，缺少 SHA256SUMS"
(cd "$target" && sha256sum -c SHA256SUMS >/dev/null) || die "备份文件完整性校验失败"
gzip -t "$target/mysql.sql.gz" || die "MySQL 备份压缩文件已损坏"
gzip -t "$target/uploads.tar.gz" || die "上传文件备份已损坏"
gzip -t "$target/communication-media.tar.gz" || die "Communication 媒体备份已损坏"

legacy_postgres_started=false
cleanup_legacy_postgres() {
  if [[ "$legacy_postgres_started" == true ]]; then
    compose --profile legacy-migration stop postgres >/dev/null 2>&1 || true
    compose --profile legacy-migration rm -f postgres >/dev/null 2>&1 || true
  fi
}
trap cleanup_legacy_postgres EXIT

warn "恢复会覆盖 GoodJob 自己的统一 MySQL 数据库，但不会操作其他容器或数据库"
read -r -p "输入 RESTORE-GOODJOB 确认：" confirmation
[[ "$confirmation" == "RESTORE-GOODJOB" ]] || die "已取消"

export GOODJOB_RELEASE_ID="$(cat "$STATE_DIR/current-release" 2>/dev/null || release_id)"
log "覆盖前先备份当前统一 MySQL"
"$SCRIPT_DIR/backup.sh"
compose stop gateway backend communication

restore_volume() {
  local volume_name="$1"
  local archive_name="$2"
  local mountpoint=""
  mountpoint="$(docker volume inspect --format '{{.Mountpoint}}' "$volume_name" 2>/dev/null || true)"
  [[ -n "$mountpoint" && -d "$mountpoint" ]] || die "找不到数据卷：$volume_name"
  find "$mountpoint" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
  tar -xzf "$target/$archive_name" -C "$mountpoint"
}

log "恢复 GoodJob MySQL"
compose exec -T mysql sh -ec \
  'MYSQL_PWD="$(cat /run/secrets/mysql_root_password)" mysql -u root -e "DROP DATABASE IF EXISTS \`$MYSQL_DATABASE\`; CREATE DATABASE \`$MYSQL_DATABASE\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; GRANT ALL PRIVILEGES ON \`$MYSQL_DATABASE\`.* TO '\''$MYSQL_USER'\''@'\''%'\''; FLUSH PRIVILEGES;"'
gzip -dc "$target/mysql.sql.gz" | compose exec -T mysql sh -ec \
  'MYSQL_PWD="$(cat /run/secrets/mysql_root_password)" exec mysql -u root'

log "恢复上传文件与 Communication 媒体"
restore_volume goodjobcrm_uploads_data uploads.tar.gz
restore_volume goodjobcrm_communication_media communication-media.tar.gz

compose --profile tools run --rm backend-migrate
compose --profile tools run --rm communication-migrate

legacy_dump=""
if [[ -s "$target/postgres.dump" ]]; then
  legacy_dump="$target/postgres.dump"
elif [[ -s "$target/legacy-postgres.dump" ]]; then
  legacy_dump="$target/legacy-postgres.dump"
fi
if [[ -n "$legacy_dump" ]]; then
  warn "检测到旧双数据库备份，将先恢复 PostgreSQL 快照，再迁入统一 MySQL"
  compose --profile legacy-migration up -d --wait postgres
  legacy_postgres_started=true
  compose --profile legacy-migration exec -T postgres sh -ec \
    'PGPASSWORD="$(cat /run/secrets/postgres_password)" dropdb -U "$POSTGRES_USER" --if-exists "$POSTGRES_DB" && PGPASSWORD="$(cat /run/secrets/postgres_password)" createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
  compose --profile legacy-migration exec -T postgres sh -ec \
    'PGPASSWORD="$(cat /run/secrets/postgres_password)" pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges' \
    < "$legacy_dump"
  compose --profile tools --profile legacy-migration run --rm \
    -e MIGRATE_FROM_POSTGRES=true \
    communication-migrate \
    node dist-server/server/scripts/migrate-postgres-to-mysql.js --apply --resume-completed
  cleanup_legacy_postgres
  legacy_postgres_started=false
fi

compose up -d --no-build communication backend gateway
wait_for_url "http://127.0.0.1:${GOODJOB_HTTP_PORT}/api/health" 60 \
  || die "恢复后应用未通过健康检查"
log "恢复完成"
