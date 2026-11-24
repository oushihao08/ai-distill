<!-- 文件职责：说明系统级只读诊断工具及其数据访问边界。 -->
# 诊断脚本

`read-logs.ts` 按筛选条件读取 logger 管理的 JSONL 日志，输出净化后的有限事件；不读取材料产物或 Codex 私有事件，不访问数据库。

示例：`bun scripts/diagnostics/read-logs.ts --attempt-id <attempt_id>` 或 `bun scripts/diagnostics/read-logs.ts --library-job-id <library_job_id>`。支持按 `library_job_id`、`library_package_id` 查询独立材料库日志；其他参数及扫描限制见根 `AGENTS.md`。

`compare-api-aliases.ts prepare|run`仅用于2026-10-27固定八包API化名对照。prepare通过本机HTTP GET冻结同源提取和Agent基线，run调用现有API模型并逐包更新本地报告；不派发业务任务、不连接或写入业务数据库。私有原文、计划及结果位于`执行观察/api-aliases-20261027/private/`，公开报告仅列指标。收费模型测试需对应授权；started没有结算时拒绝自动重发，已结算样本跳过。具体样本和验收见该任务报告。

## PDF 坐标探针与扫描件实验打码脚本（仅授权单文件实验）

| 脚本 | 用途与边界 |
| --- | --- |
| `glm-ocr-layout-probe.ts` | 探测 `GLM-OCR` `layout_parsing` 原始坐标与文本块粒度，原始响应仅写 0600 私有目录，不接入材料库 |
| `build-pdf-mask-plan.ts` | 基于已脱敏材料差异与 GLM-OCR 坐标生成独立 `mask-plan.private.json`（只读业务库，不调用模型） |
| `redact-pdf-native.swift` | macOS AppKit 独立验证工具：按像素遮盖计划把白底与假名烘焙入扫描 PDF 页面内容流 |
| `redact_pdf_pymupdf.py` | PyMuPDF 独立验证工具：直接涂白扫描 PDF 嵌入图像像素并回填假名，不改现有业务数据 |
