# 第七期历史维护脚本（`tools/q7/`）

适用范围与读者：回溯第七期（`q7-run-20261101`）批次续跑与历史孤儿任务处理的维护人员。

## 关键文件

| 文件 | 用途与入口 | 副作用与使用限制 |
| --- | --- | --- |
| `resume.py` | `python3 tools/q7/resume.py [--skip-prepare\|--only-author\|--dry-run]`：读取 `.storage/q7-run-20261101/ledger.json` 续跑第七期 9 个包的整理与出题，检测额度耗尽自动停止 | 绑定历史固定台账路径；日常新批次改用 CLI `library batch`、`project materials onboard` 与 `step dispatch` |
| `db-inspect.ts` | `bun tools/q7/db-inspect.ts`：历史排障时只读核对数据库时钟与近 3 小时 `library_jobs` 状态 | 直连 PG 只读查询；常规排查请改用 `library job show` 或 `scripts/diagnostics/read-logs.ts` |
| `db-fix-prepare.ts` | `bun tools/q7/db-fix-prepare.ts`：针对 `q7-run-20261101` 孤儿整理任务的一次性人工状态修正留档 | **高风险写库脚本**（修改 `library_jobs`）；仅作历史留档，未经用户针对性明确授权严禁执行，现行队列恢复统一走 `queue abandon-job` / `library prepare resume` |
