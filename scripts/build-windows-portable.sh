#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-$(node -p "require('$PROJECT_ROOT/frontend/public/product-config.json').version")}" 
DIST_DIR="$PROJECT_ROOT/dist-packages"
BUILD_ROOT="$PROJECT_ROOT/.build-windows-portable"
CACHE_ROOT="${GOODJOB_RUNTIME_CACHE:-$PROJECT_ROOT/.runtime-cache}"
PACKAGE_ROOT="$BUILD_ROOT/GoodJob-CRM-Windows-v$VERSION"
APP_ROOT="$PACKAGE_ROOT/app"
RUNTIME_ROOT="$PACKAGE_ROOT/runtime"
NODE_VERSION="v22.23.2"
NODE_ARCHIVE="node-$NODE_VERSION-win-x64.zip"
NODE_SHA256="1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97"
MARIADB_VERSION="11.4.12"
MARIADB_ARCHIVE="mariadb-$MARIADB_VERSION-winx64.zip"
MARIADB_SHA256="4db7f8003d4a64ac8042b771c6d34ed04c7ffae8cf52775275b72f2bd4dd17a9"
OUTPUT_FILE="$DIST_DIR/GoodJob-CRM-v$VERSION-Windows-x64-Portable.zip"

log() { printf '[WINDOWS BUILD] %s\n' "$*"; }
die() { printf '[WINDOWS BUILD] ERROR: %s\n' "$*" >&2; exit 1; }

verify_sha256() {
  local file="$1" expected="$2" actual
  actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  [[ "$actual" == "$expected" ]] || die "SHA256 不匹配：$file"
}

download_once() {
  local url="$1" file="$2" sha="$3"
  mkdir -p "$(dirname "$file")"
  if [[ -f "$file" ]] && verify_sha256 "$file" "$sha" 2>/dev/null; then return; fi
  rm -f "$file"
  curl --fail --location --retry 3 --connect-timeout 20 --output "$file" "$url"
  verify_sha256 "$file" "$sha"
}

copy_tree() {
  local source="$1" destination="$2"
  mkdir -p "$destination"
  rsync -a --delete --exclude='.DS_Store' "$source/" "$destination/"
}

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] || die "版本号格式无效：$VERSION"
command -v node >/dev/null || die "构建机缺少 Node.js"
command -v npm >/dev/null || die "构建机缺少 npm"
command -v bsdtar >/dev/null || die "构建机缺少 bsdtar"
command -v zip >/dev/null || die "构建机缺少 zip"
command -v rsync >/dev/null || die "构建机缺少 rsync"

log "1/9 构建 CRM 与 Communication"
cd "$PROJECT_ROOT"
npm run build

log "2/9 创建最小生产依赖树"
rm -rf "$BUILD_ROOT"
mkdir -p "$APP_ROOT" "$RUNTIME_ROOT" "$DIST_DIR" "$CACHE_ROOT"
STAGING_DEPS="$BUILD_ROOT/production-dependencies"
mkdir -p "$STAGING_DEPS"
node - "$PROJECT_ROOT/backend/package.json" "$PROJECT_ROOT/whatsapp-plugin/package.json" "$STAGING_DEPS/package.json" <<'NODE'
const fs = require("node:fs");
const [backendPath, communicationPath, targetPath] = process.argv.slice(2);
const backend = JSON.parse(fs.readFileSync(backendPath, "utf8"));
const communication = JSON.parse(fs.readFileSync(communicationPath, "utf8"));
const communicationServerDependencies = { ...communication.dependencies };
for (const name of ["@electric-sql/pglite", "@tanstack/react-query", "lucide-react", "pg", "react", "react-dom", "socket.io-client"]) {
  delete communicationServerDependencies[name];
}
fs.writeFileSync(targetPath, JSON.stringify({
  name: "goodjob-windows-runtime-dependencies",
  version: "1.0.0",
  private: true,
  dependencies: { ...backend.dependencies, ...communicationServerDependencies }
}, null, 2));
NODE
(
  cd "$STAGING_DEPS"
  PUPPETEER_SKIP_DOWNLOAD=true npm install --omit=dev --ignore-scripts --no-audit --no-fund --os=win32 --cpu=x64 --registry="${NPM_CONFIG_REGISTRY:-https://registry.npmmirror.com}"
)

log "3/9 组装仅运行所需应用文件"
mkdir -p "$APP_ROOT/backend/dist" "$APP_ROOT/frontend/dist" "$APP_ROOT/communication/dist" "$APP_ROOT/communication/dist-server"
copy_tree "$PROJECT_ROOT/backend/dist" "$APP_ROOT/backend/dist"
copy_tree "$PROJECT_ROOT/frontend/dist" "$APP_ROOT/frontend/dist"
copy_tree "$PROJECT_ROOT/whatsapp-plugin/dist" "$APP_ROOT/communication/dist"
copy_tree "$PROJECT_ROOT/whatsapp-plugin/dist-server" "$APP_ROOT/communication/dist-server"
copy_tree "$STAGING_DEPS/node_modules" "$APP_ROOT/node_modules"
find "$APP_ROOT/backend/dist" "$APP_ROOT/communication/dist-server" -type f \( -name '*-test.js' -o -name '*.test.js' -o -name '*.spec.js' \) -delete
rm -f "$APP_ROOT/communication/dist-server/server/scripts/migrate-postgres-to-mysql.js"
[[ -d "$PROJECT_ROOT/agent-skills" ]] && copy_tree "$PROJECT_ROOT/agent-skills" "$APP_ROOT/agent-skills"
[[ -d "$PROJECT_ROOT/agent-knowledge" ]] && copy_tree "$PROJECT_ROOT/agent-knowledge" "$APP_ROOT/agent-knowledge"
cp "$PROJECT_ROOT/LICENSE" "$PROJECT_ROOT/NOTICE" "$PROJECT_ROOT/THIRD_PARTY_NOTICES.md" "$APP_ROOT/"
cat > "$APP_ROOT/package.json" <<JSON
{
  "name": "goodjob-crm-windows-app",
  "version": "$VERSION",
  "platform": "win32",
  "architecture": "x64",
  "packageFormatVersion": 2,
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

log "4/9 清理 npm 文档、缓存与开发残留"
find "$APP_ROOT/node_modules" -type d \( -name test -o -name tests -o -name __tests__ -o -name docs -o -name examples -o -name coverage -o -name .github \) -prune -exec rm -rf {} +
find "$APP_ROOT/node_modules" -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.md' -o -name '.npmignore' \) -delete
find "$APP_ROOT/node_modules" -type f -name '*.ts' -delete
find "$APP_ROOT/node_modules" -type f \( -name 'test.js' -o -name '*-test.js' -o -name '*.test.js' -o -name '*.spec.js' \) -delete
find "$APP_ROOT/node_modules" -type f \( -name '.travis.yml' -o -name 'appveyor.yml' -o -name 'azure-pipelines.yml' \) -delete
find "$APP_ROOT/node_modules" -type f \( -name '.git*' -o -name '.env*' \) -delete
find "$APP_ROOT/node_modules" -type d -name '.bin' -prune -exec rm -rf {} +
find "$APP_ROOT" -type f \( -name '*.map' -o -name '*.d.ts' \) -delete
find "$APP_ROOT" -name '.DS_Store' -delete
find "$APP_ROOT/node_modules" -type d \( -name 'darwin-*' -o -name 'linux-*' -o -name 'win32-arm64' \) -prune -exec rm -rf {} +
find "$APP_ROOT/node_modules" -depth -type d -empty -delete
if find "$APP_ROOT" -type l -print | grep -q .; then
  find "$APP_ROOT" -type l -print
  die "应用包不能包含符号链接"
fi
if find "$APP_ROOT/node_modules" -type f -name '*.node' ! -path '*win32-x64*' -print | grep -q .; then
  find "$APP_ROOT/node_modules" -type f -name '*.node' ! -path '*win32-x64*' -print
  die "生产依赖树混入非 Windows x64 原生模块"
fi

log "5/9 下载并校验 Node.js Windows x64"
NODE_CACHE="$CACHE_ROOT/$NODE_ARCHIVE"
download_once "https://nodejs.org/dist/$NODE_VERSION/$NODE_ARCHIVE" "$NODE_CACHE" "$NODE_SHA256"
NODE_EXTRACT="$BUILD_ROOT/node-extract"
mkdir -p "$NODE_EXTRACT"
bsdtar -xf "$NODE_CACHE" -C "$NODE_EXTRACT"
mkdir -p "$RUNTIME_ROOT/node"
cp "$NODE_EXTRACT/node-$NODE_VERSION-win-x64/node.exe" "$RUNTIME_ROOT/node/node.exe"
cp "$NODE_EXTRACT/node-$NODE_VERSION-win-x64/LICENSE" "$RUNTIME_ROOT/node/LICENSE"

log "6/9 下载并校验 MariaDB Windows x64 便携版"
MARIA_CACHE="$CACHE_ROOT/$MARIADB_ARCHIVE"
download_once "https://archive.mariadb.org/mariadb-$MARIADB_VERSION/winx64-packages/$MARIADB_ARCHIVE" "$MARIA_CACHE" "$MARIADB_SHA256"
MARIA_EXTRACT="$BUILD_ROOT/mariadb-extract"
mkdir -p "$MARIA_EXTRACT"
bsdtar -xf "$MARIA_CACHE" -C "$MARIA_EXTRACT"
copy_tree "$MARIA_EXTRACT/mariadb-$MARIADB_VERSION-winx64" "$RUNTIME_ROOT/mariadb"
rm -rf "$RUNTIME_ROOT/mariadb/data" "$RUNTIME_ROOT/mariadb/include" "$RUNTIME_ROOT/mariadb/lib/plugin/debug" "$RUNTIME_ROOT/mariadb/mysql-test"
find "$RUNTIME_ROOT/mariadb" -type f \( -name '*.pdb' -o -name '*.lib' \) -delete
find "$RUNTIME_ROOT/mariadb/bin" -maxdepth 1 -type f \
  ! -name '*.dll' \
  ! -name 'mariadbd.exe' \
  ! -name 'mariadb.exe' \
  ! -name 'mariadb-admin.exe' \
  ! -name 'mariadb-dump.exe' \
  ! -name 'mariadb-install-db.exe' \
  ! -name 'my_print_defaults.exe' \
  -delete

log "7/9 安装启动、停止、诊断与事务更新脚本"
cp "$PROJECT_ROOT/scripts/windows/"*.ps1 "$PROJECT_ROOT/scripts/windows/"*.psm1 "$PROJECT_ROOT/scripts/windows/"*.mjs "$RUNTIME_ROOT/"
cp "$PROJECT_ROOT/scripts/windows/GoodJob-CRM.cmd" "$PACKAGE_ROOT/START-GOODJOB.cmd"
cp "$PROJECT_ROOT/scripts/windows/GoodJob-CRM-Stop.cmd" "$PACKAGE_ROOT/STOP-GOODJOB.cmd"
cp "$PROJECT_ROOT/scripts/windows/GoodJob-CRM-Diagnose.cmd" "$PACKAGE_ROOT/DIAGNOSE-GOODJOB.cmd"
cp "$PROJECT_ROOT/scripts/windows/GoodJob-CRM-Update.cmd" "$PACKAGE_ROOT/UPDATE-GOODJOB.cmd"
PUBLIC_KEY_PATH="${GOODJOB_UPDATE_PUBLIC_KEY:-$PROJECT_ROOT/scripts/windows/update-public-key.pem}"
if [[ -f "$PUBLIC_KEY_PATH" ]]; then
  cp "$PUBLIC_KEY_PATH" "$RUNTIME_ROOT/update-public-key.pem"
else
  cat > "$RUNTIME_ROOT/update-public-key.pem.example" <<'EOF'
正式发布前，请把 Ed25519 公钥 PEM 放到 runtime/update-public-key.pem。
构建时设置 GOODJOB_UPDATE_PUBLIC_KEY=/absolute/path/update-public-key.pem 可自动嵌入。
EOF
fi
cat > "$PACKAGE_ROOT/README-FIRST.txt" <<'EOF'
GoodJob CRM Windows x64 便携版

1. 完整解压 ZIP，不要直接在压缩包内双击。
2. 双击 START-GOODJOB.cmd。首次启动会初始化包内 MariaDB，大约需要 1-3 分钟。
3. Node.js 与 MariaDB 均在包内，不安装系统服务，也不会修改电脑现有 Node/MySQL。
4. 业务数据、上传、日志和备份位于：%LOCALAPPDATA%\GoodJobCRM
5. 首次账号位于：%LOCALAPPDATA%\GoodJobCRM\config\首次登录账号.txt
6. 正常退出请双击 STOP-GOODJOB.cmd。故障时运行 DIAGNOSE-GOODJOB.cmd。
7. 更新源在 CRM 系统设置中配置；一键更新强制先备份数据库，失败不会覆盖旧版本。

支持：Windows 10 1809+ / Windows 11，x64。
EOF

log "8/9 生成逐文件完整性清单并做黑名单审计"
(
  cd "$APP_ROOT"
  find . -type f ! -name 'PACKAGE-MANIFEST.sha256' -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 | sed 's#  \./#  #' > PACKAGE-MANIFEST.sha256
)
if find "$APP_ROOT" \( -path '*/.git*' -o -path '*/.svn*' -o -path "$APP_ROOT/backend/src/*" -o -path "$APP_ROOT/frontend/src/*" -o -path "$APP_ROOT/communication/src/*" -o -name '*.env*' -o -name '*.sql' -o -name '*.log' \) -print | grep -q .; then
  find "$APP_ROOT" \( -path '*/.git*' -o -path '*/.svn*' -o -path "$APP_ROOT/backend/src/*" -o -path "$APP_ROOT/frontend/src/*" -o -path "$APP_ROOT/communication/src/*" -o -name '*.env*' -o -name '*.sql' -o -name '*.log' \) -print
  die "包内出现禁止文件"
fi
for required in \
  "$APP_ROOT/backend/dist/server.js" \
  "$APP_ROOT/backend/dist/migrate-mysql.js" \
  "$APP_ROOT/frontend/dist/index.html" \
  "$APP_ROOT/communication/dist/index.html" \
  "$APP_ROOT/communication/dist-server/server/index.js" \
  "$RUNTIME_ROOT/node/node.exe" \
  "$RUNTIME_ROOT/mariadb/bin/mariadbd.exe" \
  "$RUNTIME_ROOT/mariadb/bin/mariadb.exe" \
  "$RUNTIME_ROOT/mariadb/bin/mariadb-dump.exe"; do
  [[ -f "$required" ]] || die "包缺少 $required"
done

log "9/9 创建 Windows ZIP"
rm -f "$OUTPUT_FILE" "$OUTPUT_FILE.sha256"
(
  cd "$BUILD_ROOT"
  zip -q -r -9 "$OUTPUT_FILE" "$(basename "$PACKAGE_ROOT")"
)
shasum -a 256 "$OUTPUT_FILE" > "$OUTPUT_FILE.sha256"
log "完成：$OUTPUT_FILE"
du -h "$OUTPUT_FILE"
