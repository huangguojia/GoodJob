#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"
load_env

timestamp="$(date +%Y%m%d-%H%M%S)"
target="$BACKUP_DIR/$timestamp"
install -d -m 0700 "$target"

compose ps --status running mysql --quiet | grep -q . \
  || die "统一 MySQL 未运行，拒绝生成不完整备份"
log "备份 GoodJob 统一 MySQL（包含 CRM 与 Communication）"
compose exec -T mysql sh -ec \
  'MYSQL_PWD="$(cat /run/secrets/mysql_root_password)" exec mysqldump -u root --single-transaction --routines --triggers --databases "$MYSQL_DATABASE"' \
  | gzip -c > "$target/mysql.sql.gz"
gzip -t "$target/mysql.sql.gz" || die "MySQL 备份压缩文件校验失败"

archive_volume() {
  local volume_name="$1"
  local archive_name="$2"
  local mountpoint=""
  mountpoint="$(docker volume inspect --format '{{.Mountpoint}}' "$volume_name" 2>/dev/null || true)"
  [[ -n "$mountpoint" && -d "$mountpoint" ]] || die "找不到数据卷：$volume_name"
  tar -C "$mountpoint" -czf "$target/$archive_name" .
  gzip -t "$target/$archive_name" || die "数据卷备份损坏：$archive_name"
}

if ! docker volume inspect goodjobcrm_uploads_data >/dev/null 2>&1; then
  log "首次创建上传文件持久卷"
  docker volume create \
    --label com.docker.compose.project=goodjobcrm \
    --label com.docker.compose.volume=uploads_data \
    goodjobcrm_uploads_data >/dev/null
  legacy_backend_container="$(compose ps --quiet backend 2>/dev/null || true)"
  if [[ -n "$legacy_backend_container" ]]; then
    uploads_mountpoint="$(docker volume inspect --format '{{.Mountpoint}}' goodjobcrm_uploads_data)"
    if docker cp "$legacy_backend_container:/app/uploads/." "$uploads_mountpoint/" >/dev/null 2>&1; then
      log "已把旧后端容器中的上传文件迁入持久卷"
    else
      warn "旧后端容器没有可迁移的 /app/uploads，使用空上传卷继续"
    fi
  fi
fi

log "备份上传文件、Logo、公章、签名与 Communication 媒体"
archive_volume goodjobcrm_uploads_data uploads.tar.gz
archive_volume goodjobcrm_communication_media communication-media.tar.gz

cp -p "$ENV_FILE" "$target/deploy.env"
cp -a "$SECRETS_DIR" "$target/secrets"
chmod -R go-rwx "$target"
(cd "$target" && find . -type f ! -name SHA256SUMS -print \
  | LC_ALL=C sort \
  | while IFS= read -r file; do sha256sum "$file"; done \
  > SHA256SUMS)
log "备份完成：$target"

retention="${GOODJOB_BACKUP_RETENTION_COUNT:-10}"
[[ "$retention" =~ ^[0-9]+$ ]] && (( retention >= 2 && retention <= 100 )) \
  || die "GOODJOB_BACKUP_RETENTION_COUNT 必须是 2 到 100 之间的整数"
kept=0
while IFS= read -r candidate; do
  name="$(basename "$candidate")"
  [[ "$name" =~ ^[0-9]{8}-[0-9]{6}$ ]] || continue
  kept=$((kept + 1))
  if (( kept > retention )); then
    find "$candidate" -depth -delete
    log "已清理超过保留数量的旧备份：$name"
  fi
done < <(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -print | LC_ALL=C sort -r)
