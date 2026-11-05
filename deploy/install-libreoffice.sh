#!/bin/bash
# 安装文档预览所需的 LibreOffice（不需要管理员密码）
#
# 为什么需要它：Word/Excel/PPT（含 WPS 存出的 .docx/.xlsx/.pptx）浏览器打不开，
# 必须由服务端先转成 PDF。macOS 自带的 qlmanage/sips 只能出缩略图，不能出多页 PDF，
# 所以 Office 预览这条路绕不开 LibreOffice。
#
# 装到 ~/Applications 而不是 /Applications：后者需要 sudo，而服务是以当前用户跑的。
# file-derive.ts 的能力探测已经把 ~/Applications 列为候选路径。
#
# 用法：bash deploy/install-libreoffice.sh
set -uo pipefail

SOFFICE="$HOME/Applications/LibreOffice.app/Contents/MacOS/soffice"

if [ -x "$SOFFICE" ]; then
  echo "已安装：$("$SOFFICE" --version 2>/dev/null | head -1)"
  echo "位置：$SOFFICE"
  exit 0
fi

if ! command -v brew >/dev/null 2>&1; then
  echo "未找到 Homebrew。请手动下载 LibreOffice 并放到 ~/Applications。" >&2
  echo "下载地址：https://www.libreoffice.org/download/download/" >&2
  exit 1
fi

echo "==> 下载 LibreOffice 安装包（约 285MB，只下载不安装，无需密码）"
# 先把 dmg 拉到本地缓存；这一步不需要管理员权限
brew fetch --cask libreoffice || {
  echo "下载失败。可手动下载 dmg 后执行：" >&2
  echo "  hdiutil attach <dmg> && cp -R /Volumes/LibreOffice/LibreOffice.app ~/Applications/" >&2
  exit 1
}

DMG=$(find "$HOME/Library/Caches/Homebrew/downloads" -name "*LibreOffice*.dmg" | head -1)
if [ -z "$DMG" ]; then
  echo "没有在 Homebrew 缓存里找到 dmg，请手动安装。" >&2
  exit 1
fi

echo "==> 挂载 $DMG"
MOUNT=$(hdiutil attach "$DMG" -nobrowse -readonly | grep -o '/Volumes/.*' | head -1)
if [ -z "$MOUNT" ]; then
  echo "挂载失败。" >&2
  exit 1
fi

echo "==> 复制到 ~/Applications"
mkdir -p "$HOME/Applications"
rm -rf "$HOME/Applications/LibreOffice.app"
cp -R "$MOUNT/LibreOffice.app" "$HOME/Applications/" || {
  hdiutil detach "$MOUNT" -quiet
  echo "复制失败。" >&2
  exit 1
}
hdiutil detach "$MOUNT" -quiet

if [ ! -x "$SOFFICE" ]; then
  echo "安装后仍找不到 soffice，请检查。" >&2
  exit 1
fi

echo "==> 完成：$("$SOFFICE" --version 2>/dev/null | head -1)"
echo
echo "下一步：重启后端让能力探测生效"
echo "  launchctl kickstart -k gui/\$(id -u)/com.goodjob.crm.backend"
echo
echo "注意：中文字体由 deploy/fontconfig/fonts.conf 提供，后端会自动注入，无需额外配置。"
echo "      如果想 100% 还原版式，可把真正的 SimSun/SimHei 字体装进系统字体目录。"
