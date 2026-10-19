#!/usr/bin/env bash
# 职责：从任意当前目录定位仓库并启动本地 API、worker 与前端。
# 入口与影响：`bash scripts/runtime/start.sh`；由 Bun 执行，端口被占用时退出；不安装依赖、不停止已有服务、不迁移数据库。
set -euo pipefail
DISTILL_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$DISTILL_ROOT"
exec bun scripts/runtime/start.ts
