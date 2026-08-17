#!/usr/bin/env bash
set -Eeuo pipefail

VERSION="${1:?用法：make-update.sh <version> <mirror-output-dir> [asset-base-url]}"
MIRROR_DIR="${2:?请提供镜像源输出目录}"
ASSET_BASE_URL="${3:-}"
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORTABLE_ZIP="$PROJECT_ROOT/dist-packages/GoodJob-CRM-v$VERSION-Windows-x64-Portable.zip"
PRIVATE_KEY="${GOODJOB_UPDATE_PRIVATE_KEY:-}"

[[ -f "$PORTABLE_ZIP" ]] || "$PROJECT_ROOT/scripts/build-windows-portable.sh" "$VERSION"
[[ -n "$PRIVATE_KEY" && -f "$PRIVATE_KEY" ]] || {
  printf '错误：需要设置 GOODJOB_UPDATE_PRIVATE_KEY=/path/to/ed25519-private-key.pem\n' >&2
  exit 1
}

mkdir -p "$MIRROR_DIR"
MIRROR_DIR="$(cd "$MIRROR_DIR" && pwd)"
mkdir -p "$MIRROR_DIR/releases/$VERSION"
ASSET_NAME="goodjob-app-$VERSION-win-x64.zip"
ASSET_PATH="$MIRROR_DIR/releases/$VERSION/$ASSET_NAME"
TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEMP_ROOT"' EXIT
bsdtar -xf "$PORTABLE_ZIP" -C "$TEMP_ROOT"
PORTABLE_ROOT="$(find "$TEMP_ROOT" -mindepth 1 -maxdepth 1 -type d | head -1)"
[[ -d "$PORTABLE_ROOT/app" ]] || { echo "便携包缺少 app 目录" >&2; exit 1; }
(cd "$PORTABLE_ROOT" && zip -q -r -9 "$ASSET_PATH" app)
ASSET_SHA="$(shasum -a 256 "$ASSET_PATH" | awk '{print $1}')"
ASSET_SIZE="$(stat -f%z "$ASSET_PATH" 2>/dev/null || stat --printf='%s' "$ASSET_PATH")"
ASSET_URL="${ASSET_BASE_URL:+${ASSET_BASE_URL%/}/}releases/$VERSION/$ASSET_NAME"

cat > "$MIRROR_DIR/manifest.json" <<JSON
{
  "packageFormatVersion": 2,
  "latestVersion": "$VERSION",
  "minimumVersion": "1.2.4",
  "releases": {
    "$VERSION": {
      "date": "$(date +%Y-%m-%d)",
      "databaseCompatibility": "backward-compatible",
      "windows": {
        "url": "$ASSET_URL",
        "size": $ASSET_SIZE,
        "sha256": "$ASSET_SHA"
      },
      "changelog": "请填写本次更新内容",
      "credits": "<p>GoodJob CRM 安全更新：数据库备份成功后才会切换版本。</p>"
    }
  }
}
JSON

node - "$MIRROR_DIR/manifest.json" "$MIRROR_DIR/manifest.sig" "$PRIVATE_KEY" <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const { sign } = require("node:crypto");
const [manifestPath, signaturePath, privateKeyPath] = process.argv.slice(2);
const signature = sign(null, readFileSync(manifestPath), readFileSync(privateKeyPath, "utf8"));
writeFileSync(signaturePath, signature.toString("base64") + "\n");
NODE

printf '更新镜像已生成：%s\n' "$MIRROR_DIR"
printf '请发布 manifest.json、manifest.sig 和 releases/%s/%s\n' "$VERSION" "$ASSET_NAME"
