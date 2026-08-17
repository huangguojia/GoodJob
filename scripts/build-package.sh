#!/bin/bash
set -euo pipefail

# ════════════════════════════════════════════════════════════════
#  GoodJob CRM 一键启动包构建脚本
#  用法: ./scripts/build-package.sh [mac|win] [version]
#  示例: ./scripts/build-package.sh mac 1.0.0
# ════════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PACKAGING_DIR="$SCRIPT_DIR/packaging"
BUILD_DIR="$PROJECT_ROOT/.build-tmp"
DIST_DIR="$PROJECT_ROOT/dist-packages"

PLATFORM="${1:-mac}"
VERSION="${2:-1.0.0}"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log() { echo -e "${GREEN}[BUILD]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err() { echo -e "${RED}[ERROR]${NC} $1"; }

# ── 前置检查 ──────────────────────────────────────────────────────
log "开始构建 GoodJob CRM v${VERSION} for ${PLATFORM}"

if [ ! -f "$PROJECT_ROOT/backend/package.json" ]; then
  err "未找到 backend/package.json，请在项目根目录运行"
  exit 1
fi

# ── 清理旧的构建目录 ──────────────────────────────────────────────
log "清理旧构建目录..."
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# ── Step 1: 编译后端 TypeScript ──────────────────────────────────
log "Step 1/7: 编译后端 TypeScript..."
cd "$PROJECT_ROOT/backend"
npx tsc -p tsconfig.json 2>&1
if [ $? -ne 0 ]; then
  err "后端编译失败"
  exit 1
fi
log "后端编译完成 -> backend/dist/"

# ── Step 2: 混淆后端代码 (可选) ──────────────────────────────────
log "Step 2/7: 混淆后端代码..."
cd "$PROJECT_ROOT"
# 安装 javascript-obfuscator (如果尚未安装)
if ! npx javascript-obfuscator --version >/dev/null 2>&1; then
  warn "javascript-obfuscator 未安装，跳过混淆 (源码保护降级)"
  warn "如需混淆: npm install -g javascript-obfuscator"
else
  OBFUSCATED_DIR="$BUILD_DIR/backend-obfuscated"
  mkdir -p "$OBFUSCATED_DIR"
  npx javascript-obfuscator \
    "$PROJECT_ROOT/backend/dist" \
    --output "$OBFUSCATED_DIR" \
    --compact true \
    --control-flow-flattening true \
    --control-flow-flattening-threshold 0.75 \
    --dead-code-injection true \
    --dead-code-injection-threshold 0.4 \
    --string-array true \
    --string-array-encoding base64 \
    --string-array-threshold 0.75 \
    --rename-globals false \
    --self-defending true \
    2>&1 || {
    warn "混淆失败，使用未混淆代码"
    cp -r "$PROJECT_ROOT/backend/dist" "$OBFUSCATED_DIR"
  }
  log "后端代码混淆完成"
fi

# ── Step 3: 构建前端 ─────────────────────────────────────────────
log "Step 3/7: 构建前端..."
cd "$PROJECT_ROOT/frontend"
npx vite build 2>&1
if [ $? -ne 0 ]; then
  err "前端构建失败"
  exit 1
fi
log "前端构建完成 -> frontend/dist/"

# ── Step 4: 准备 production node_modules ─────────────────────────
log "Step 4/7: 准备 production 依赖..."
PROD_MODULES_DIR="$BUILD_DIR/node_modules"
mkdir -p "$PROD_MODULES_DIR"

# 从根 node_modules 复制后端 production 依赖
cd "$PROJECT_ROOT"
BACKEND_DEPS=$(node -e "
  const pkg = require('./backend/package.json');
  console.log(Object.keys(pkg.dependencies || {}).join(' '));
")

for dep in $BACKEND_DEPS; do
  if [ -d "node_modules/$dep" ]; then
    cp -r "node_modules/$dep" "$PROD_MODULES_DIR/"
    log "  复制 $dep"
  else
    warn "  缺少依赖: $dep"
  fi
  # 处理 scoped packages (@scope/name)
done

# 复制 @scope 依赖
for scoped_dir in node_modules/@*; do
  if [ -d "$scoped_dir" ]; then
    scope_name=$(basename "$scoped_dir")
    mkdir -p "$PROD_MODULES_DIR/$scope_name"
    for pkg_dir in "$scoped_dir"/*/; do
      pkg_name=$(basename "$pkg_dir")
      # 检查是否在 backend dependencies 中
      if node -e "
        const pkg = require('./backend/package.json');
        const deps = Object.keys(pkg.dependencies || {});
        process.exit(deps.includes('@$scope_name/$pkg_name') ? 0 : 1);
      " 2>/dev/null; then
        cp -r "$pkg_dir" "$PROD_MODULES_DIR/$scope_name/"
        log "  复制 @$scope_name/$pkg_name"
      fi
    done
  fi
done

log "Production 依赖准备完成"

# ── Step 5: 组装包结构 ───────────────────────────────────────────
log "Step 5/7: 组装包结构..."
PACKAGE_DIR="$BUILD_DIR/goodjob-crm"
rm -rf "$PACKAGE_DIR"
mkdir -p "$PACKAGE_DIR"

# 5.1 后端代码
mkdir -p "$PACKAGE_DIR/backend/dist"
if [ -d "$BUILD_DIR/backend-obfuscated" ]; then
  cp -r "$BUILD_DIR/backend-obfuscated/"* "$PACKAGE_DIR/backend/dist/"
else
  cp -r "$PROJECT_ROOT/backend/dist/"* "$PACKAGE_DIR/backend/dist/"
fi

# 5.2 前端代码
mkdir -p "$PACKAGE_DIR/frontend/dist"
cp -r "$PROJECT_ROOT/frontend/dist/"* "$PACKAGE_DIR/frontend/dist/"

# 5.3 node_modules
cp -r "$PROD_MODULES_DIR" "$PACKAGE_DIR/backend/node_modules"

# 5.4 数据库 schema
cp "$PROJECT_ROOT/backend/schema.mysql.sql" "$PACKAGE_DIR/backend/"
# 全量数据 (首次初始化用)
if [ -f "$PROJECT_ROOT/backend/goodjob_crm.full.sql" ]; then
  cp "$PROJECT_ROOT/backend/goodjob_crm.full.sql" "$PACKAGE_DIR/backend/"
fi

# 5.5 agent-knowledge
if [ -d "$PROJECT_ROOT/agent-knowledge" ]; then
  cp -r "$PROJECT_ROOT/agent-knowledge" "$PACKAGE_DIR/agent-knowledge"
fi

# 5.6 agent-skills
if [ -d "$PROJECT_ROOT/agent-skills" ]; then
  cp -r "$PROJECT_ROOT/agent-skills" "$PACKAGE_DIR/agent-skills"
fi

# 5.7 版本信息
cat > "$PACKAGE_DIR/package.json" << EOF
{
  "name": "goodjob-crm",
  "version": "${VERSION}",
  "platform": "${PLATFORM}",
  "buildDate": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

# 5.8 环境配置模板
cat > "$PACKAGE_DIR/.env" << 'EOF'
CRM_STORE=mysql
NODE_ENV=production
PORT=4188
BACKEND_HOST=127.0.0.1
CORS_ORIGINS=http://127.0.0.1:4188,http://localhost:4188
SESSION_COOKIE_SECURE=false
ENABLE_API_DOCS=false
CRM_SEED_DEVELOPMENT_DATA=true
PROSPECT_WORKER_ENABLED=false
PROSPECT_QUEUE_REQUIRED=false
REDIS_URL=
EOF

# 5.9 启动器
if [ "$PLATFORM" = "mac" ]; then
  cp "$PACKAGING_DIR/launcher-mac.sh" "$PACKAGE_DIR/launcher.sh"
  chmod +x "$PACKAGE_DIR/launcher.sh"
elif [ "$PLATFORM" = "win" ]; then
  cp "$PACKAGING_DIR/launcher-win.bat" "$PACKAGE_DIR/launcher.bat"
fi

# 5.10 更新模块配置
cat > "$PACKAGE_DIR/update-config.json" << 'EOF'
{
  "mirrorUrl": "",
  "currentVersion": "",
  "autoCheck": true,
  "channel": "stable"
}
EOF

log "包结构组装完成"

# ── Step 6: 下载 Node.js 运行时 ──────────────────────────────────
log "Step 6/7: 下载 Node.js 运行时..."
NODE_VERSION="v22.22.2"

if [ "$PLATFORM" = "mac" ]; then
  ARCH=$(uname -m)
  if [ "$ARCH" = "arm64" ]; then
    NODE_ARCH="arm64"
  else
    NODE_ARCH="x64"
  fi
  NODE_TARBALL="node-${NODE_VERSION}-darwin-${NODE_ARCH}.tar.gz"
  NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/${NODE_TARBALL}"
elif [ "$PLATFORM" = "win" ]; then
  NODE_ZIP="node-${NODE_VERSION}-win-x64.zip"
  NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/${NODE_ZIP}"
fi

NODE_CACHE="$BUILD_DIR/node-runtime"
mkdir -p "$NODE_CACHE"

if [ "$PLATFORM" = "mac" ]; then
  if [ ! -f "$NODE_CACHE/node/bin/node" ]; then
    log "  下载 ${NODE_TARBALL}..."
    curl -L -o "$NODE_CACHE/$NODE_TARBALL" "$NODE_URL"
    tar -xzf "$NODE_CACHE/$NODE_TARBALL" -C "$NODE_CACHE"
    # 提取 node 二进制
    cp "$NODE_CACHE/node-${NODE_VERSION}-darwin-${NODE_ARCH}/bin/node" "$PACKAGE_DIR/"
  fi
  log "Node.js 运行时已嵌入"
elif [ "$PLATFORM" = "win" ]; then
  if [ ! -f "$NODE_CACHE/node.exe" ]; then
    log "  下载 ${NODE_ZIP}..."
    curl -L -o "$NODE_CACHE/$NODE_ZIP" "$NODE_URL"
    # Windows 需要在 Windows 上解压，这里只下载
    warn "Windows Node.js 需要在 Windows 上构建，已下载到 $NODE_CACHE/"
  fi
fi

# ── Step 7: 打包压缩 ─────────────────────────────────────────────
log "Step 7/7: 打包压缩..."
mkdir -p "$DIST_DIR"

if [ "$PLATFORM" = "mac" ]; then
  OUTPUT_FILE="$DIST_DIR/goodjob-crm-v${VERSION}-mac.tar.gz"
  cd "$BUILD_DIR"
  tar -czf "$OUTPUT_FILE" goodjob-crm
  log "打包完成: $OUTPUT_FILE"
elif [ "$PLATFORM" = "win" ]; then
  OUTPUT_FILE="$DIST_DIR/goodjob-crm-v${VERSION}-win.zip"
  cd "$BUILD_DIR"
  zip -r "$OUTPUT_FILE" goodjob-crm
  log "打包完成: $OUTPUT_FILE"
fi

# ── 显示包体积 ───────────────────────────────────────────────────
PACKAGE_SIZE=$(du -sh "$OUTPUT_FILE" | cut -f1)
log ""
log "═══════════════════════════════════════════════════════"
log "  构建完成!"
log "  版本: v${VERSION}"
log "  平台: ${PLATFORM}"
log "  文件: $OUTPUT_FILE"
log "  体积: ${PACKAGE_SIZE}"
log "═══════════════════════════════════════════════════════"
log ""
log "下一步:"
log "  1. 将包分发给用户"
log "  2. 用户解压后运行 launcher.sh (Mac) 或 launcher.bat (Win)"
log "  3. 浏览器打开 http://localhost:4188"
log ""

# ── 清理 ─────────────────────────────────────────────────────────
rm -rf "$BUILD_DIR"
log "临时构建目录已清理"
