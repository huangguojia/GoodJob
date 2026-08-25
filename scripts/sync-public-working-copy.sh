#!/usr/bin/env bash
set -euo pipefail

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_ROOT="${GOODJOB_PUBLIC_WORKING_COPY:-$HOME/Desktop/GoodJob_svn}"
EXPECTED_URL="svn://gitee.com/sendoh-huang/GoodJob"
DRY_RUN=0

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
elif [[ $# -gt 0 ]]; then
  printf 'Usage: %s [--dry-run]\n' "$0" >&2
  exit 2
fi

if [[ ! -d "$TARGET_ROOT/.svn" ]]; then
  printf 'Public working copy not found: %s\n' "$TARGET_ROOT" >&2
  exit 1
fi

actual_url="$(svn info --show-item url "$TARGET_ROOT")"
if [[ "$actual_url" != "$EXPECTED_URL" ]]; then
  printf 'Refusing to sync unexpected SVN target: %s\n' "$actual_url" >&2
  exit 1
fi

rsync_args=(
  -a
  --delete
  --itemize-changes
  --exclude=/.svn/
  --exclude=/AGENTS.md
  --exclude=/.env
  --exclude=/.env.*.local
  --exclude='**/.env'
  --exclude='**/.env.*.local'
  --exclude='**/node_modules/'
  --exclude='**/dist/'
  --exclude=/backend/uploads/
  --exclude=/whatsapp-plugin/.data/
  --exclude=/database-backups/
  --exclude=/dist-packages/
  --exclude='/.build-*/'
  --exclude='/*.csv'
  --exclude='*.log'
  --exclude='*.tsbuildinfo'
  --exclude=/.DS_Store
)

if [[ $DRY_RUN -eq 1 ]]; then
  rsync_args+=(--dry-run)
  printf 'Previewing public release sync\n'
else
  printf 'Syncing canonical source to public working copy\n'
fi

rsync "${rsync_args[@]}" "$SOURCE_ROOT/" "$TARGET_ROOT/"

if [[ $DRY_RUN -eq 0 ]]; then
  (cd "$TARGET_ROOT" && npm run svn:check-database)
  printf 'Public working copy generated. Review svn status before committing.\n'
fi
