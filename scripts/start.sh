#!/usr/bin/env bash
# 职责：从任意启动目录定位仓库，交由 Bun 启动本地 API、worker 和前端；不安装或迁移。
set -euo pipefail
DISTILL_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DISTILL_ROOT"
exec bun scripts/start.ts
