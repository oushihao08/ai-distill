#!/usr/bin/env bash
# 职责：将与 `origin/main` 一致的干净 `main` 提交打包并经 SSH 更新指定服务器。
# 入口与影响：`./scripts/runtime/deploy.sh`；每次把本机 `.env` 一并传输并替换远端配置，触发 Swarm 服务更新；需生产操作授权，不运行数据库迁移。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REMOTE_HOST="${AI_DISTILL_DEPLOY_HOST:-}"
REMOTE_USER="${AI_DISTILL_DEPLOY_USER:-}"
REMOTE_DIR="${AI_DISTILL_DEPLOY_DIR:-}"

fail() { printf '发布失败：%s\n' "$1" >&2; exit 1; }

command -v git >/dev/null || fail '找不到 git'
command -v ssh >/dev/null || fail '找不到 ssh'
command -v tar >/dev/null || fail '找不到 tar'
local_env="$ROOT/.env"
[[ -f "$local_env" && ! -L "$local_env" ]] || fail '仓库根目录缺少普通文件 .env'
grep -Eq '^[[:space:]]*DATABASE_URL[[:space:]]*=[[:space:]]*[^[:space:]]+' "$local_env" || fail '本机 .env 缺少 DATABASE_URL'
[[ -n "$REMOTE_HOST" ]] || fail '请通过 AI_DISTILL_DEPLOY_HOST 明确指定目标服务器'
[[ "$REMOTE_HOST" =~ ^[A-Za-z0-9._:-]+$ ]] || fail 'AI_DISTILL_DEPLOY_HOST 格式无效'
[[ -n "$REMOTE_USER" ]] || fail '请通过 AI_DISTILL_DEPLOY_USER 明确指定 SSH 用户'
[[ "$REMOTE_USER" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] || fail 'AI_DISTILL_DEPLOY_USER 格式无效'
[[ -n "$REMOTE_DIR" ]] || fail '请通过 AI_DISTILL_DEPLOY_DIR 明确指定服务器数据目录'
[[ "$REMOTE_DIR" =~ ^/[A-Za-z0-9._/-]+$ && "$REMOTE_DIR" != *..* ]] || fail 'AI_DISTILL_DEPLOY_DIR 必须是安全的绝对路径'
[[ "$(git -C "$ROOT" branch --show-current)" == main ]] || fail '请切换到 main 分支后发布'

git -C "$ROOT" fetch origin main
remote_ref="$(git -C "$ROOT" rev-parse origin/main)"
head_ref="$(git -C "$ROOT" rev-parse HEAD)"
[[ "$head_ref" == "$remote_ref" ]] || fail '本地 main 与 GitHub main 不一致；请先手动完成提交和推送，再发布'
[[ -z "$(git -C "$ROOT" status --porcelain --untracked-files=all)" ]] || fail '工作区有未提交文件；请先检查并提交所需发布内容'
for path in scripts/runtime/deploy-server.sh Dockerfile docker-stack.yml .dockerignore; do
  git -C "$ROOT" cat-file -e "$remote_ref:$path" 2>/dev/null || fail "GitHub main 发布快照缺少 $path"
done

tag="${remote_ref:0:12}"
temp_root="$(mktemp -d "${TMPDIR:-/tmp}/ai-distill-deploy.XXXXXX")"
chmod 700 "$temp_root"
trap 'rm -rf "$temp_root"' EXIT
mkdir -m 700 "$temp_root/release"
git -C "$ROOT" archive "$remote_ref" | tar -x -C "$temp_root/release"
for path in scripts/runtime/deploy-server.sh Dockerfile docker-stack.yml .dockerignore; do
  [[ -f "$temp_root/release/$path" ]] || fail "发布包缺少 $path"
done
install -m 600 "$local_env" "$temp_root/release/.env"
tar -czf "$temp_root/payload.tar.gz" -C "$temp_root" release
chmod 600 "$temp_root/payload.tar.gz"

printf '发布 GitHub main 提交 %s 到 %s@%s。\n' "$tag" "$REMOTE_USER" "$REMOTE_HOST"
ssh -T -o ConnectTimeout=10 "$REMOTE_USER@$REMOTE_HOST" \
  "set -e; stage=\$(mktemp -d /tmp/ai-distill-deploy.XXXXXX); trap 'rm -rf \"\$stage\"' EXIT; tar -xzf - -C \"\$stage\"; bash \"\$stage/release/scripts/runtime/deploy-server.sh\" '$tag' \"\$stage/release\" '$REMOTE_DIR'" \
  < "$temp_root/payload.tar.gz"

printf '\n访问方式：在本机另开终端运行\n  ssh -N -L 3800:127.0.0.1:37900 %s@%s\n然后打开 http://localhost:3800\n' "$REMOTE_USER" "$REMOTE_HOST"
