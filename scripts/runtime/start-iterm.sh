#!/bin/bash
# 职责：从 macOS iTerm2 启动或复用本项目 API、worker 和前端。
# 入口与影响：`npm run start:iterm`；代码过期时拒绝自动重启本项目 API/worker，前端只复用匹配进程；不安装依赖或迁移数据库。
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd)"

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

# Source edits must not be hidden behind a still-running Bun process. Migrations
# and project materials are excluded because they are not loaded as server code.
latest_runtime_source_mtime() {
  local latest=0 file mtime
  while IFS= read -r -d '' file; do
    [[ "$file" == *.test.ts || "$file" == *.spec.ts ]] && continue
    mtime="$(stat -f '%m' "$file" 2>/dev/null || printf '0')"
    if (( mtime > latest )); then latest="$mtime"; fi
  done < <(find "$ROOT_DIR/server" "$ROOT_DIR/shared" "$ROOT_DIR/config" -type f \( -name '*.ts' -o -name '*.json' \) -print0 2>/dev/null)
  for file in "$ROOT_DIR/package.json" "$ROOT_DIR/bun.lock" "$ROOT_DIR/.env"; do
    [[ -f "$file" ]] || continue
    mtime="$(stat -f '%m' "$file" 2>/dev/null || printf '0')"
    if (( mtime > latest )); then latest="$mtime"; fi
  done
  printf '%s' "$latest"
}

RUNTIME_SOURCE_MTIME="$(latest_runtime_source_mtime)"
STALE_SERVICE_PIDS=()

add_stale_pid() {
  local candidate="$1" existing
  for existing in "${STALE_SERVICE_PIDS[@]:-}"; do
    [[ "$existing" == "$candidate" ]] && return
  done
  STALE_SERVICE_PIDS+=("$candidate")
}

check_service_freshness() {
  local port="$1" role="$2" expected="$3" service_dir="$4"
  local pids pid cwd command_line started_at started_epoch
  pids="$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  [[ -n "$pids" ]] || return 0
  for pid in $pids; do
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
    command_line="$(ps -p "$pid" -o command=)"
    command_line="${command_line//bun run /bun }"
    if [[ "$cwd" != "$service_dir" || "$command_line" != *"$expected"* ]]; then
      printf '%s端口 %s 被其他进程占用（PID %s）；未停止任何服务。\n' "$role" "$port" "$pid" >&2
      return 1
    fi
    started_at="$(ps -p "$pid" -o lstart= | sed 's/^ *//')"
    started_epoch="$(date -j -f '%a %b %e %T %Y' "$started_at" '+%s' 2>/dev/null || true)"
    if [[ ! "$started_epoch" =~ ^[0-9]+$ ]]; then
      printf '无法确认%s进程（PID %s）的启动时间；未停止任何服务。\n' "$role" "$pid" >&2
      return 1
    fi
    if (( RUNTIME_SOURCE_MTIME > started_epoch )); then add_stale_pid "$pid"; fi
  done
}

check_worker_freshness() {
  local pid cwd command_line started_at started_epoch
  for pid in $(pgrep -f 'bun (run )?server/worker\.ts([[:space:]]|$)' || true); do
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
    command_line="$(ps -p "$pid" -o command=)"
    command_line="${command_line//bun run /bun }"
    [[ "$cwd" == "$ROOT_DIR" && "$command_line" == *"bun server/worker.ts"* ]] || continue
    started_at="$(ps -p "$pid" -o lstart= | sed 's/^ *//')"
    started_epoch="$(date -j -f '%a %b %e %T %Y' "$started_at" '+%s' 2>/dev/null || true)"
    if [[ ! "$started_epoch" =~ ^[0-9]+$ ]]; then
      printf '无法确认材料处理进程（PID %s）的启动时间；未停止任何服务。\n' "$pid" >&2
      return 1
    fi
    if (( RUNTIME_SOURCE_MTIME > started_epoch )); then add_stale_pid "$pid"; fi
  done
}

# Never replace a live process: its environment overrides and in-flight claims
# cannot be safely reconstructed from a monitor snapshot.
check_service_freshness 3700 后端 'bun server/index.ts' "$ROOT_DIR"
check_worker_freshness
if (( ${#STALE_SERVICE_PIDS[@]} > 0 )); then
  printf '检测到本项目服务代码已更新（PID：%s）；为保留原启动范围并避免领取竞争，本入口不自动停止或重启。请按原参数安全停止后再次启动。\n' "${STALE_SERVICE_PIDS[*]}" >&2
  exit 1
fi

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
    # Bun accepts both `bun file.ts` and `bun run file.ts` for these entrypoints.
    command_line="${command_line//bun run /bun }"
    if [[ "$cwd" != "$service_dir" || "$command_line" != *"$expected"* ]]; then
      printf '%s端口 %s 被其他进程占用（PID %s）；未启动或停止任何服务。\n' "$role" "$port" "$pid" >&2
      return 1
    fi
  done
  printf "printf '%s已运行（端口%s），复用现有服务。\\n'" "$role" "$port"
}

BACKEND_COMMAND="$(service_command 3700 后端 server 'bun server/index.ts' "$ROOT_DIR")"
FRONTEND_COMMAND="$(service_command 3800 前端 dev "/node_modules/.bin/vite" "$ROOT_DIR/web")"

WORKER_COMMAND="cd $ROOT_Q && $BUN_Q run worker"
for worker_pid in $(pgrep -f 'bun (run )?server/worker\.ts([[:space:]]|$)' || true); do
  worker_cwd="$(lsof -a -p "$worker_pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
  worker_line="$(ps -p "$worker_pid" -o command=)"
  worker_line="${worker_line//bun run /bun }"
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

printf '已在 iTerm2 三个页签启动或复用前后端与材料处理进程，请检查各页签输出。前端地址：http://127.0.0.1:3800/\n'
