#!/bin/bash
# 平台固定模板，请勿改动，直接使用本模板。

set -uo pipefail

# --- judge 凭据：JUDGE_*（task.toml [verifier.env] 声明、平台注入）优先，EVAL_API_* 为旧环境兜底 ---
_JUDGE_KEY="${JUDGE_API_KEY:-${EVAL_API_KEY:-}}"
_JUDGE_BASE="${JUDGE_BASE_URL:-${EVAL_API_BASE:-}}"
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-${_JUDGE_BASE}}"
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL%/v1}"
export ANTHROPIC_AUTH_TOKEN="${ANTHROPIC_AUTH_TOKEN:-${_JUDGE_KEY}}"
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-${_JUDGE_KEY}}"
# --- OpenAI 兼容配置（若被降级回 LLM judge 时可用）---
export OPENAI_API_KEY="${OPENAI_API_KEY:-${_JUDGE_KEY}}"
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-${_JUDGE_BASE}}"
export OPENAI_API_BASE="${OPENAI_API_BASE:-${_JUDGE_BASE}}"
# --- 裁判模型运行时可配：rewardkit 原生识别 REWARDKIT_MODEL / REWARDKIT_JUDGE ---
export REWARDKIT_MODEL="${REWARDKIT_MODEL:-${JUDGE_MODEL:-GPT-5.5}}"
# JUDGE_API_PROTOCOL=openai 时降级为 openai 协议 LLM judge（覆盖 rubrics.toml 的 judge 类型）
if [ "${JUDGE_API_PROTOCOL:-anthropic}" = "openai" ]; then
  export REWARDKIT_JUDGE="${REWARDKIT_JUDGE:-openai/${REWARDKIT_MODEL}}"
fi
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
# claude-code 以 root 运行时拒绝 bypassPermissions（--dangerously-skip-permissions
# root 保护）；IS_SANDBOX=1 是官方逃生舱，容器化评测环境属预期场景。
export IS_SANDBOX=1
[ -f "$HOME/.local/bin/env" ] && source "$HOME/.local/bin/env"
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"

# rewardkit 调 claude 时不带 --permission-mode，
# 非交互模式默认权限下 Bash/Read 会被拒。
# 写 settings.json 强制 bypassPermissions（claude 启动时自动读取）。
mkdir -p "$HOME/.claude"
cat > "$HOME/.claude/settings.json" <<'SETTINGS'
{
  "permissions": {
    "defaultMode": "bypassPermissions"
  }
}
SETTINGS

if ! command -v rewardkit &> /dev/null; then
  echo "[test.sh] rewardkit executable not found; verifier image must preinstall harbor-rewardkit" >&2
  exit 1
fi

mkdir -p /logs/verifier/graded

# fail-closed 兜底：判分器中途被杀（超时/OOM/容器回收）时，留下的必须是
# "评分不可用"，而不是一个有效 0 分——纯数字的 reward.txt 带不出"不可信"，
# 必须与 reward_exit_message.json 配合。finalize.py 正常收尾会覆盖这些文件
# （成功时删除错误文件）。
echo "0.0" > /logs/verifier/reward.txt
cat > /logs/verifier/reward.json <<'JSON'
{"graded_score": 0.0, "criteria_counted": 0.0,
 "reward": 0.0, "verifier_error": 1.0}
JSON
cat > /logs/verifier/reward_exit_message.json <<'JSON'
{"exit_code": "judge:unknown",
 "exit_reason": "verifier did not finish (killed before finalize.py); fail-closed placeholder",
 "extra_fields": {}}
JSON

# stderr 落盘供 finalize.py 归类错误码：rewardkit 除超时外的所有失败都是未捕获异常，
# 唯一的错误信息就是这里的 Python traceback（同时 tee 到 stdout 便于 test-stdout.txt 排查）。
rewardkit /tests --workspace /app --output /logs/verifier/graded/reward.json \
  2> >(tee /logs/verifier/graded/stderr.txt >&2)
graded_rc=$?

python3 /tests/finalize.py \
  --graded /logs/verifier/graded/reward.json --graded-rc "$graded_rc" \
  --out /logs/verifier/reward.json
