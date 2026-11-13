#!/usr/bin/env bash
# Shared launcher for play.sh / play-stable.sh / 尘迹拉力.app (sourced, not run).
#
#   dustmark_launch <build dir> <query> <chrome profile name> <port> [fallback ports …]
#
# 1. Server: for each candidate port —
#      a DUSTMARK server (scripts/serve.mjs) already serving this build there  → reuse it (another window / session)
#      nothing listening on the port nor on port+1000                           → start scripts/serve.mjs there
#      anything else (an old `vite preview`, another program, a DUSTMARK server serving a different build)
#                                                                              → say so and try the next port
#    Never stops a process it did not start.
# 2. Browser: Google Chrome in --app mode with its own profile, so it is a separate process we can wait for.
#    No Chrome → a clear message (and the URL to open in another browser; Ctrl+C stops the server).
# 3. When the window closes, the server this launch started is stopped.
#
# Env for testing without a window: DUSTMARK_NO_BROWSER=1 (start / reuse the server, print the URL and the chosen
# port as "DUSTMARK_PORT=<port>", leave the server running and print its pid as "DUSTMARK_SERVER_PID=<pid>").
# DUSTMARK_CHROME=<path> overrides the Chrome binary.

DUSTMARK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

# prints: ours | other | busy | free
dustmark_port_state() {
  local port=$1 dir=$2 info
  info=$(curl -s --max-time 1 "http://127.0.0.1:$port/pair-info" 2>/dev/null || true)
  if [[ "$info" == *'"httpsPort"'* ]]; then
    # a DUSTMARK server; older ones do not report their directory (treat as ours)
    if [[ "$info" != *'"dir"'* || "$info" == *"\"dir\":\"$dir\""* ]]; then echo ours; else echo other; fi
    return
  fi
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1 || lsof -nP -iTCP:"$((port + 1000))" -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo busy
  else
    echo free
  fi
}

dustmark_find_chrome() {
  local c
  for c in "${DUSTMARK_CHROME:-}" \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
    [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}

dustmark_launch() {
  local dir query profile
  dir="$(cd "$1" && pwd -P)"; query=$2; profile=$3; shift 3
  local port="" state p
  DUSTMARK_STARTED=""
  for p in "$@"; do
    state=$(dustmark_port_state "$p" "$dir")
    case "$state" in
      ours) port=$p; echo "端口 $p 上已经有 DUSTMARK 服务在跑这个版本，直接用它。"; break ;;
      free)
        node "$DUSTMARK_ROOT/scripts/serve.mjs" --dir "$dir" --port "$p" --https-port "$((p + 1000))" &
        DUSTMARK_STARTED=$!
        local i
        for i in $(seq 1 80); do
          curl -s -o /dev/null "http://127.0.0.1:$p/" && { port=$p; break; }
          kill -0 "$DUSTMARK_STARTED" 2>/dev/null || break
          sleep 0.1
        done
        if [ -n "$port" ]; then break; fi
        kill "$DUSTMARK_STARTED" 2>/dev/null || true
        DUSTMARK_STARTED=""
        echo "端口 $p 启动失败，换下一个。" ;;
      other) echo "端口 $p 上是另一个 DUSTMARK 版本的服务（不是 ${dir}），不动它，换下一个端口。" ;;
      busy)
        local who
        who=$(lsof -nP -iTCP:"$p" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1" (pid "$2")"}' || true)
        echo "端口 $p 或 $((p + 1000)) 被别的程序占用${who:+：$who}（不是 DUSTMARK 服务，不去关它），换下一个端口。" ;;
    esac
  done
  if [ -z "$port" ]; then
    echo "错误：端口 $* 都用不了。用 lsof -nP -iTCP:<端口> -sTCP:LISTEN 看看是谁占着，关掉后再试。" >&2
    return 1
  fi
  [ -n "$DUSTMARK_STARTED" ] && trap '[ -n "$DUSTMARK_STARTED" ] && kill "$DUSTMARK_STARTED" 2>/dev/null || true' EXIT
  local url="http://localhost:$port/?$query"
  if [ -n "${DUSTMARK_NO_BROWSER:-}" ]; then
    echo "DUSTMARK_PORT=$port"; echo "DUSTMARK_URL=$url"; echo "DUSTMARK_SERVER_PID=${DUSTMARK_STARTED}"
    trap - EXIT
    return 0
  fi
  local chrome
  if ! chrome=$(dustmark_find_chrome); then
    echo "没找到 Google Chrome（游戏按 Chrome 开发和测试）。请从 https://www.google.com/chrome/ 安装后再运行。" >&2
    if [ -n "$DUSTMARK_STARTED" ] && [ -t 0 ]; then
      echo "服务先开着：也可以用别的浏览器打开 $url 试试（按 Ctrl+C 结束）。" >&2
      wait "$DUSTMARK_STARTED"
    fi
    return 1
  fi
  local pdir="${TMPDIR:-/tmp}/$profile"
  # separate profile → its own Chrome process: we can wait for the window to close, then stop the server
  "$chrome" --user-data-dir="$pdir" --app="$url" --start-fullscreen --no-first-run --no-default-browser-check \
    --disable-background-timer-throttling --disable-renderer-backgrounding >/dev/null 2>&1 || true
  # if a window with this profile was already open, Chrome hands the URL to it and returns at once: wait for that one
  while pgrep -f -- "--user-data-dir=$pdir" >/dev/null 2>&1; do sleep 1; done
  return 0
}
