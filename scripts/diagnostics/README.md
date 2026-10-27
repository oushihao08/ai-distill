<!-- 文件职责：说明系统级只读诊断工具及其数据访问边界。 -->
# 诊断脚本

`read-logs.ts` 按筛选条件读取 logger 管理的 JSONL 日志，输出净化后的有限事件；不读取材料产物或 Codex 私有事件，不访问数据库。

示例：`bun scripts/diagnostics/read-logs.ts --attempt-id <attempt_id>` 或 `bun scripts/diagnostics/read-logs.ts --library-job-id <library_job_id>`。支持按 `library_job_id`、`library_package_id` 查询独立材料库日志；其他参数及扫描限制见根 `AGENTS.md`。

`compare-api-aliases.ts prepare|run`仅用于2026-10-27固定八包API化名对照。prepare通过本机HTTP GET冻结同源提取和Agent基线，run调用现有API模型并逐包更新本地报告；不派发业务任务、不连接或写入业务数据库。私有原文、计划及结果位于`执行观察/api-aliases-20261027/private/`，公开报告仅列指标。收费模型测试需对应授权；started没有结算时拒绝自动重发，已结算样本跳过。具体样本和验收见该任务报告。
