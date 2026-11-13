#!/usr/bin/env bash
# 尘迹拉力 DUSTMARK — 开发版：按需构建，起本地服务（含 iPhone 方向盘，见 docs/PHONE.md），用 Chrome 无边框全屏打开。
#   ./play.sh            构建（源码有改动时）并开玩
#   ./play.sh --no-build 直接玩上一次的构建
#   ./play.sh "cam=near" 带 URL 参数
# 端口 5198（手机页 HTTPS 6198）；被别的程序占着时自动换 5197…5194，不会去关不认识的进程。关掉游戏窗口后服务自动退出。
set -euo pipefail
cd "$(dirname "$0")"
QUERY=""
BUILD=1
for a in "$@"; do
  case "$a" in
    --no-build) BUILD=0 ;;
    *) QUERY="$a" ;;
  esac
done
command -v node >/dev/null || { echo "需要 Node.js（brew install node）"; exit 1; }
[ -d node_modules ] || npm install --registry https://registry.npmmirror.com
if [ "$BUILD" = 1 ]; then
  # rebuild only when sources/assets are newer than the last build
  if [ ! -f dist/index.html ] || [ -n "$(find src pad public index.html vite.config.ts -newer dist/index.html -print -quit 2>/dev/null)" ]; then
    echo "构建中…"
    npx vite build --logLevel warn
  fi
fi
[ -f dist/index.html ] || { echo "dist 里没有构建，先运行 ./play.sh（不带 --no-build）"; exit 1; }
source scripts/launch.sh
dustmark_launch dist "$QUERY" dustmark-chrome 5198 5197 5196 5195 5194
