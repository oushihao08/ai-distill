<!-- 文件职责：说明系统级只读诊断工具及其数据访问边界。 -->
# 诊断脚本

`read-logs.ts` 按筛选条件读取 logger 管理的 JSONL 日志，输出净化后的有限事件；不读取材料产物或 Codex 私有事件，不访问数据库。

示例：`bun scripts/diagnostics/read-logs.ts --attempt-id <attempt_id>` 或 `bun scripts/diagnostics/read-logs.ts --library-job-id <library_job_id>`。支持按 `library_job_id`、`library_package_id` 查询独立材料库日志；其他参数及扫描限制见根 `AGENTS.md`。
