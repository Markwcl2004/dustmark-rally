#!/usr/bin/env bash
# 出稳定版：npm test + npm run smoke 都通过后构建，把 dist 复制成 builds/stable（上一版留作 builds/prev）。
# ./play-stable.sh 和 尘迹拉力.app 玩的就是 builds/stable。
#
#   scripts/snapshot-stable.sh                 检查 → 构建 → builds/stable
#   scripts/snapshot-stable.sh <目标目录>       换目标（上一版放在同级的 prev；验证脚本时用临时目录）
#   SKIP_CHECKS=1 scripts/snapshot-stable.sh … 跳过 test/smoke（只给脚本自测用，别用来出正式版）
#
# 正在玩稳定版时也可以运行：新版本先完整复制到 <目标>.new，最后两次 mv 换上去；已经开着的游戏窗口刷新后才是新版。
set -euo pipefail
cd "$(dirname "$0")/.."
TARGET="${1:-builds/stable}"
TARGET="${TARGET%/}"
PREV="$(dirname "$TARGET")/prev"
NEW="$TARGET.new"
log() { echo "[snapshot] $*"; }

if [ -z "${SKIP_CHECKS:-}" ]; then
  log "npm test …"
  npm test
  log "npm run smoke …"
  npm run smoke
else
  log "SKIP_CHECKS：跳过 test / smoke"
fi
log "构建 dist …"
npx vite build --logLevel warn
[ -f dist/index.html ] || { echo "构建失败：dist/index.html 不存在" >&2; exit 1; }

mkdir -p "$(dirname "$TARGET")"
rm -rf "$NEW"
cp -R dist "$NEW"
{
  echo "built: $(date '+%Y-%m-%d %H:%M:%S')"
  echo "commit: $(git rev-parse --short HEAD 2>/dev/null || echo '?')$(git diff --quiet HEAD -- src public pad index.html 2>/dev/null || echo ' (+ uncommitted changes)')"
  echo "checks: $([ -z "${SKIP_CHECKS:-}" ] && echo 'npm test + npm run smoke passed' || echo 'SKIPPED')"
} > "$NEW/BUILD_INFO.txt"
if [ -d "$TARGET" ]; then
  rm -rf "$PREV"
  mv "$TARGET" "$PREV"
  log "上一版 → $PREV"
fi
mv "$NEW" "$TARGET"
log "稳定版 → ${TARGET}（$(du -sh "$TARGET" | cut -f1)）"
cat "$TARGET/BUILD_INFO.txt"
