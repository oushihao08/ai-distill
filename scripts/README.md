<!-- 文件职责：索引需人工选择和审查的启动、调查及验收脚本，并标注运行影响。 -->
# 人工启动、调查与验收脚本

此目录不属于日常 worker 队列。脚本名称中的 verify／review 不代表只读或已验收；部分会连接真实数据库、调用模型、上传 PDF 和写证据文件。不要批量运行全部脚本。执行前阅读目标脚本，核对当前文件路径、历史任务 ID、输出覆盖和授权。

| 脚本 | 用途／运行影响 |
| --- | --- |
| `start-iterm.sh` | macOS 启动或复用本项目 API、前端、worker；源码晚于 API／worker 进程时，先确认没有运行中任务再正常停止旧进程并重启；任务状态未知或仍在运行时不停止服务；同时识别 `bun file.ts` / `bun run file.ts`，核对项目目录；不迁移数据库，不停止占用端口的其他进程 |
| `read-logs.ts` | 只读筛选本机结构化日志；限制扫描文件数、字节数及结果条数 |
| `verify-project-folders.ts`、`verify-input-versions.ts`、`verify-generated-cleanup.ts` | 临时 PostgreSQL schema 与合成材料；目录接收、版本、重置和清理 |
| `verify-rule-versions.ts`、`verify-rule-loading.ts` | 旧编号规则版本流程的历史验收脚本；对应 API 与步骤已停用，不适用于当前版本，也不要执行。历史结论见 `docs/evidence/2026-10-08-rule-loading.md`；当前输入约定见 `docs/architecture.md` |
| `verify-project-skill-queue.ts` | 临时数据库、注入生成器；候选队列、采用与冻结 |
| `verify-project-skill.ts` | 真实首期规则与真实 Codex 生成候选，不自动采用发布 |
| `verify-codex-isolation.ts` | 本地 CLI 沙箱子进程检查，不等于模型调用验收 |
| `verify-codex-client.ts`、`verify-independent-score.ts` | 合成输入，真实 Codex 冒烟／独立评分 |
| `verify-authoring-flow.ts` | 临时数据库、合成材料，真实 Codex 出题与质检及发布检查 |
| `verify-answer-flow.ts` | 临时数据库及注入作答／评分；`--real-score` 可实际调用评分 |
| `verify-revision-loop.ts` | 临时数据库验证返修；`--real-author`、`--real-grading`、`--real-answer` 可启用相应真实调用 |
| `verify-independent-modules.ts` | 合成数据库夹具验证达标、发布、导出与费用等模块 |
| `verify-qwen.ts` | 单次合成请求，真实供应商调用，保存安全摘要 |
| `verify-domestic-models.ts` | 默认配置检查；`--call` 才对指定供应商发送一次合成请求 |
| `verify-resource-monitor.ts` | 本机资源采样及证据文件写入，非完整 worker 验收 |
| `verify-integration.ts` | 临时数据库，真实材料提取／脱敏；PDF 路径及完整／单页范围取决于环境配置 |
| `verify-real-question-folders.ts` | 指定真实题目业务流程，会改变对应工作流并调用已接入执行器 |
| `verify-ocr-page.ts` | 指定真实 PDF 页的智谱识别与实体检查 |
| `run-flash-max-question-pdfs.ts` | 真实题目页级 Flash max OCR、检查点复用与私有落盘 |
| `try-glm-ocr-sample.ts`、`try-glm-ocr-question-folder.ts` | 将指定真实 PDF 发至 layout_parsing，私有保存结果 |
| `audit-current-ocr.ts`、`review-glm-ocr-quality.ts`、`review-glm-ocr-folder-samples.ts`、`verify-ocr-speed-quality.ts` | 真实源图与候选文本的模型复核，可能调用多次；不是全文人工准确率 |
| `compare-glm-ocr-page-cache.ts` | 对齐历史 GLM-OCR 与缓存，计算文本相似度；不是识别准确率 |

常见输出在 `docs/evidence/`，包含私有原文的中间结果位于 `.storage/` 下。临时 schema 脚本通常在 finally 清理，但中断和网络故障仍需核查残留；不能把临时 schema 解释为没有数据库写入。固定历史 ID、日期或样本路径仅适用于当时调查，不是系统默认配置。

运行限制见根 [AGENTS.md](../AGENTS.md)。文档和注释任务不授权执行上述脚本，命令通过也只证明其注明的范围。
