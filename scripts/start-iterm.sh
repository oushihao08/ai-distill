#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"

BUN_BIN="$(command -v bun || true)"
if [[ -z "$BUN_BIN" && -x "$HOME/.bun/bin/bun" ]]; then
  BUN_BIN="$HOME/.bun/bin/bun"
fi
if [[ -z "$BUN_BIN" ]]; then
  printf '未找到 Bun，请先安装 Bun。\n' >&2
  exit 1
fi

if [[ ! -x "$ROOT_DIR/node_modules/.bin/vite" && ! -x "$ROOT_DIR/web/node_modules/.bin/vite" ]]; then
  printf '依赖未安装：请先在 %s 执行 bun install --frozen-lockfile\n' "$ROOT_DIR" >&2
  exit 1
fi

if [[ ! -f "$ROOT_DIR/.env" ]]; then
  printf '缺少 %s/.env，请参考 .env.example 配置数据库连接。\n' "$ROOT_DIR" >&2
  exit 1
fi

if ! command -v osascript >/dev/null 2>&1 || ! open -Ra iTerm >/dev/null 2>&1; then
  printf '需要 macOS 和已安装的 iTerm2。\n' >&2
  exit 1
fi

printf -v ROOT_Q '%q' "$ROOT_DIR"
printf -v BUN_Q '%q' "$BUN_BIN"
# Reuse only listeners whose working directory and command both match this project.
# Never terminate a process just because it owns one of our ports.
service_command() {
  local port="$1" role="$2" script="$3" expected="$4" service_dir="$5"
  local pids pid cwd command_line
  pids="$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    printf 'cd %s && %s run %s' "$ROOT_Q" "$BUN_Q" "$script"
    return
  fi
  for pid in $pids; do
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
    command_line="$(ps -p "$pid" -o command=)"
    if [[ "$cwd" != "$service_dir" || "$command_line" != *"$expected"* ]]; then
      printf '%s端口 %s 被其他进程占用（PID %s）；未启动或停止任何服务。\n' "$role" "$port" "$pid" >&2
      return 1
    fi
  done
  printf "printf '%s已运行（端口%s），复用现有服务。\\n'" "$role" "$port"
}

BACKEND_COMMAND="$(service_command 3100 后端 server 'bun server/index.ts' "$ROOT_DIR")"
FRONTEND_COMMAND="$(service_command 5173 前端 dev "/node_modules/.bin/vite" "$ROOT_DIR/web")"

WORKER_COMMAND="cd $ROOT_Q && $BUN_Q run worker"
for worker_pid in $(pgrep -f 'bun server/worker.ts' || true); do
  worker_cwd="$(lsof -a -p "$worker_pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
  worker_line="$(ps -p "$worker_pid" -o command=)"
  if [[ "$worker_cwd" == "$ROOT_DIR" && "$worker_line" == *"bun server/worker.ts"* ]]; then
    WORKER_COMMAND="printf '材料处理进程已运行，复用现有进程。\n'"
    break
  fi
done

osascript - "$BACKEND_COMMAND" "$FRONTEND_COMMAND" "$WORKER_COMMAND" <<'APPLESCRIPT'
on run argv
  tell application "iTerm"
    activate
    set appWindow to (create window with default profile)
    tell current session of appWindow to write text (item 1 of argv)
    tell appWindow to set frontendTab to (create tab with default profile)
    tell current session of frontendTab to write text (item 2 of argv)
    tell appWindow to set workerTab to (create tab with default profile)
    tell current session of workerTab to write text (item 3 of argv)
  end tell
end run
APPLESCRIPT

printf '已在 iTerm2 三个页签启动或复用前后端与材料处理进程，请检查各页签输出。前端地址：http://127.0.0.1:5173/\n'
