#!/usr/bin/env bash
# 试驾"上一个验收通过的版本"（builds/stable，由 scripts/snapshot-stable.sh 生成），不受正在开发的代码影响。
#   ./play-stable.sh            全屏开玩
#   ./play-stable.sh "cam=near" 带 URL 参数
# 端口 5199（手机页 HTTPS 6199）；被别的程序占着时自动换 5193…5191。关掉游戏窗口后服务自动退出。
set -euo pipefail
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "需要 Node.js（brew install node）"; exit 1; }
[ -f builds/stable/index.html ] || { echo "builds/stable 不存在：先运行 scripts/snapshot-stable.sh 生成稳定版，或者用 ./play.sh"; exit 1; }
[ -d node_modules/ws ] || npm install --registry https://registry.npmmirror.com
source scripts/launch.sh
dustmark_launch builds/stable "${1:-}" dustmark-chrome-stable 5199 5193 5192 5191
