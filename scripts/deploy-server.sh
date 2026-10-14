#!/usr/bin/env bash
# 文件职责：在目标服务器构建指定源码快照，并原位更新 ai-distill 的固定 Swarm 服务；接收本次发布的本机 .env。
# 入口：仅由 scripts/deploy.sh 通过 SSH 调用；不运行数据库迁移或清理持久业务数据。
set -euo pipefail

tag="${1:?缺少发布标签}"
release_dir="${2:?缺少源码目录}"
root="${3:?缺少服务器数据目录}"
[[ "$tag" =~ ^[0-9a-f]{12}$ ]] || { echo '发布标签无效' >&2; exit 1; }
[[ "$root" =~ ^/[A-Za-z0-9._/-]+$ && "$root" != *..* ]] || { echo '服务器数据目录无效' >&2; exit 1; }
[[ "$(id -u)" == 0 ]] || { echo '部署用户必须具备 root 权限以设置容器数据目录权限' >&2; exit 1; }
command -v getent >/dev/null || { echo '服务器缺少 getent，无法确认容器 UID 是否冲突' >&2; exit 1; }
if getent passwd 10001 >/dev/null; then echo '服务器 UID 10001 已被占用；请先调整容器 UID 配置并重新发布。' >&2; exit 1; fi
[[ ! -L "$root" ]] || { echo '服务器数据目录不能是符号链接' >&2; exit 1; }
[[ -f "$release_dir/Dockerfile" && -f "$release_dir/docker-stack.yml" ]] || { echo '发布快照缺少 Docker 部署文件' >&2; exit 1; }
[[ -f "$release_dir/.env" && ! -L "$release_dir/.env" ]] || { echo '发布包缺少本次发布的普通文件 .env' >&2; exit 1; }
grep -Eq '^[[:space:]]*DATABASE_URL[[:space:]]*=[[:space:]]*[^[:space:]]+' "$release_dir/.env" || { echo '本次发布的 .env 缺少 DATABASE_URL' >&2; exit 1; }
docker info --format '{{.Swarm.LocalNodeState}}' | grep -qx active || { echo 'Docker Swarm 未启用' >&2; exit 1; }
existing_services="$(docker service ls --format '{{.Name}}' | grep '^ai-distill' | sort || true)"
while IFS= read -r service; do
  [[ -n "$service" ]] || continue
  case "$service" in ai-distill_api|ai-distill_worker) ;; *) echo "发现未托管的 ai-distill 服务 $service；拒绝创建重复服务。" >&2; exit 1 ;; esac
  namespace="$(docker service inspect "$service" --format '{{index .Spec.Labels "com.docker.stack.namespace"}}' 2>/dev/null || true)"
  [[ "$namespace" == ai-distill ]] || { echo "服务 $service 不属于 ai-distill stack；拒绝覆盖。" >&2; exit 1; }
done <<< "$existing_services"

has_old_api=0
has_old_worker=0
if grep -qx 'ai-distill_api' <<< "$existing_services"; then has_old_api=1; fi
if grep -qx 'ai-distill_worker' <<< "$existing_services"; then has_old_worker=1; fi
old_api=""
old_worker=""
old_api_version=""
old_worker_version=""
if (( has_old_api )); then
  old_api="$(docker service inspect ai-distill_api --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' 2>/dev/null || true)"
  old_api_version="$(docker service inspect ai-distill_api --format '{{.Version.Index}}' 2>/dev/null || true)"
  [[ -n "$old_api" && -n "$old_api_version" ]] || { echo '无法读取现有 API 服务版本' >&2; exit 1; }
fi
if (( has_old_worker )); then
  old_worker="$(docker service inspect ai-distill_worker --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' 2>/dev/null || true)"
  old_worker_version="$(docker service inspect ai-distill_worker --format '{{.Version.Index}}' 2>/dev/null || true)"
  [[ -n "$old_worker" && -n "$old_worker_version" ]] || { echo '无法读取现有 worker 服务版本' >&2; exit 1; }
fi

assert_worker_idle() {
  if (( ! has_old_worker )); then return 0; fi
  task="$(docker service ps --filter desired-state=running -q ai-distill_worker | head -n1)"
  container=""
  if [[ -n "$task" ]]; then container="$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' "$task" 2>/dev/null || true)"; fi
  [[ -n "$container" ]] || { echo '无法读取现有 worker 心跳；为避免中断任务，停止部署' >&2; return 1; }
  docker exec "$container" bun -e 'try{const s=await Bun.file("/app/.storage/.worker-monitor.json").json();const age=Date.now()-Date.parse(s.heartbeat_at);const t=s.snapshot?.tasks;process.exit(["running","paused"].includes(s.status)&&Number.isFinite(age)&&age>=-5000&&age<30000&&t?.status==="known"&&t.value.running===0?0:1)}catch{process.exit(1)}' || { echo 'worker 有运行任务或心跳不可信；等待任务结束后再部署' >&2; return 1; }
}

storage="$root/storage"
env_target="$root/.env"
storage_owner_marker="$storage/.ai-distill-storage-owner-10001"
deployed=0
env_updated=0
previous_env_exists=0
env_backup="$release_dir/.env.previous"
[[ ! -L "$env_target" ]] || { echo '服务器 .env 不能是符号链接' >&2; exit 1; }
if [[ -e "$env_target" && ! -f "$env_target" ]]; then echo '服务器 .env 必须是普通文件' >&2; exit 1; fi
assert_worker_idle || exit 1
[[ ! -L "$storage" ]] || { echo '持久存储目录不能是符号链接' >&2; exit 1; }
[[ ! -L "$storage_owner_marker" ]] || { echo '存储所有者标记不能是符号链接' >&2; exit 1; }
mkdir -p "$storage"
if [[ ! -f "$storage_owner_marker" || "$(stat -c '%u' "$storage_owner_marker")" != 10001 ]]; then
  chown -R 10001:10001 "$storage"
fi
chmod 700 "$storage"
export AI_DISTILL_IMAGE="ai-distill:$tag"
export AI_DISTILL_STORAGE_DIR="$storage"
export AI_DISTILL_PROJECTS_DIR="$root/projects"
[[ -d "$AI_DISTILL_PROJECTS_DIR" && ! -L "$AI_DISTILL_PROJECTS_DIR" ]] || { echo '服务器尚未同步项目来源目录；请先同步到部署目录的 projects 子目录。' >&2; exit 1; }
export AI_DISTILL_ENV_FILE="$env_target"
export AI_DISTILL_ENV_REV="${tag}-$(date -u +%Y%m%dT%H%M%SZ)-$$"

old_tag=""
if [[ "$old_api" =~ ^ai-distill:([0-9a-f]{12})$ ]]; then old_tag="${BASH_REMATCH[1]}"; fi

rollback_on_error() {
  status=$?
  if (( status != 0 )); then
    if (( env_updated )); then
      if (( previous_env_exists )); then
        if ! install -o root -g 10001 -m 640 "$env_backup" "$env_target"; then echo '无法恢复上一版 .env；需人工核对服务器配置。' >&2; fi
      else
        if ! unlink "$env_target"; then echo '无法移除本次新建的 .env；需人工核对服务器配置。' >&2; fi
      fi
    fi
    if (( deployed )); then
      if (( has_old_api )); then
        current_api_version="$(docker service inspect ai-distill_api --format '{{.Version.Index}}' 2>/dev/null || true)"
        if [[ -n "$current_api_version" && "$current_api_version" != "$old_api_version" ]]; then docker service rollback ai-distill_api || true; fi
      else
        docker service rm ai-distill_api >/dev/null 2>&1 || true
      fi
      if (( has_old_worker )); then
        current_worker_version="$(docker service inspect ai-distill_worker --format '{{.Version.Index}}' 2>/dev/null || true)"
        if [[ -n "$current_worker_version" && "$current_worker_version" != "$old_worker_version" ]]; then docker service rollback ai-distill_worker || true; fi
      else
        docker service rm ai-distill_worker >/dev/null 2>&1 || true
      fi
      restored=0
      for _ in $(seq 1 90); do
        api_ok=0
        worker_ok=0
        if (( has_old_api )); then
          api_replicas="$(docker service ls --filter name=ai-distill_api --format '{{.Replicas}}' | head -n1)"
          api_image="$(docker service inspect ai-distill_api --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' 2>/dev/null || true)"
          api_task="$(docker service ps --filter desired-state=running -q ai-distill_api | head -n1)"
          api_container=""
          api_health=""
          if [[ -n "$api_task" ]]; then api_container="$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' "$api_task" 2>/dev/null || true)"; fi
          if [[ -n "$api_container" ]]; then api_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$api_container" 2>/dev/null || true)"; fi
          [[ "$api_replicas" == '1/1' && "$api_image" == "$old_api" && -n "$api_container" && "$api_health" == healthy ]] && api_ok=1
        else
          if ! docker service inspect ai-distill_api >/dev/null 2>&1; then api_ok=1; fi
        fi
        if (( has_old_worker )); then
          worker_replicas="$(docker service ls --filter name=ai-distill_worker --format '{{.Replicas}}' | head -n1)"
          worker_image="$(docker service inspect ai-distill_worker --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' 2>/dev/null || true)"
          worker_task="$(docker service ps --filter desired-state=running -q ai-distill_worker | head -n1)"
          [[ "$worker_replicas" == '1/1' && "$worker_image" == "$old_worker" && -n "$worker_task" ]] && worker_ok=1
        else
          if ! docker service inspect ai-distill_worker >/dev/null 2>&1; then worker_ok=1; fi
        fi
        if (( api_ok && worker_ok )); then restored=1; break; fi
        sleep 2
      done
      if (( restored )); then echo '上一服务状态已恢复或本次新建服务已清理。' >&2; else echo '回滚命令已执行，但恢复状态未通过检查；需人工核对 Swarm 服务。' >&2; fi
    fi
  fi
  exit "$status"
}
trap rollback_on_error EXIT

docker build --pull -t "$AI_DISTILL_IMAGE" "$release_dir"
if ! assert_worker_idle; then rm -f "$storage/.ai-distill-storage-owner-10001"; exit 1; fi
if [[ -f "$env_target" ]]; then
  install -o root -g 10001 -m 600 "$env_target" "$env_backup"
  previous_env_exists=1
fi
install -o root -g 10001 -m 640 "$release_dir/.env" "$env_target"
env_updated=1
deployed=1
docker stack deploy --prune --resolve-image never -c "$release_dir/docker-stack.yml" ai-distill

healthy=0
for _ in $(seq 1 90); do
  api_replicas="$(docker service ls --filter name=ai-distill_api --format '{{.Replicas}}' | head -n1)"
  worker_replicas="$(docker service ls --filter name=ai-distill_worker --format '{{.Replicas}}' | head -n1)"
  api_task="$(docker service ps --filter desired-state=running -q ai-distill_api | head -n1)"
  worker_task="$(docker service ps --filter desired-state=running -q ai-distill_worker | head -n1)"
  if [[ "$api_replicas" == '1/1' && "$worker_replicas" == '1/1' && -n "$api_task" && -n "$worker_task" ]]; then
    api_container="$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' "$api_task" 2>/dev/null || true)"
    worker_container="$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' "$worker_task" 2>/dev/null || true)"
    api_health=""
    worker_health=""
    if [[ -n "$api_container" ]]; then api_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$api_container" 2>/dev/null || true)"; fi
    if [[ -n "$worker_container" ]]; then worker_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$worker_container" 2>/dev/null || true)"; fi
    if [[ "$api_health" == healthy && "$worker_health" == healthy ]]; then healthy=1; break; fi
  fi
  sleep 2
done

if (( healthy == 0 )); then
  echo '新版本未通过 API、数据库迁移或 worker 心跳检查，尝试恢复上一版服务。' >&2
  exit 1
fi

service_names="$(docker service ls --filter label=com.docker.stack.namespace=ai-distill --format '{{.Name}}' | sort)"
expected_names=$'ai-distill_api\nai-distill_worker'
[[ "$service_names" == "$expected_names" ]] || { echo '服务清单与预期不符，停止清理旧镜像。' >&2; exit 1; }
for service in ai-distill_api ai-distill_worker; do
  replicas="$(docker service ls --filter name="$service" --format '{{.Replicas}}' | head -n1)"
  running="$(docker service ps --filter desired-state=running -q "$service" | wc -l | tr -d ' ')"
  [[ "$replicas" == '1/1' && "$running" == 1 ]] || { echo "$service 未保持单副本运行。" >&2; exit 1; }
done

install -o 10001 -g 10001 -m 600 /dev/null "$storage_owner_marker"

if [[ -n "$old_tag" && "$old_tag" != "$tag" ]]; then keep_tags="^($tag|$old_tag)$"; else keep_tags="^($tag)$"; fi
while IFS= read -r image_tag; do
  [[ -n "$image_tag" ]] || continue
  if [[ ! "$image_tag" =~ $keep_tags ]]; then docker image rm "ai-distill:$image_tag" >/dev/null 2>&1 || true; fi
done < <(docker image ls ai-distill --format '{{.Tag}}' | sort -u)

echo "部署成功：ai-distill:$tag；API 和 API worker 各 1 个副本，持久存储位于 $storage。"
echo '数据库迁移未执行。'
