<!-- 文件职责：索引跨项目系统验收脚本并提醒其运行影响。 -->
# 跨项目验证脚本

本目录只放系统或跨项目验证，不放某个项目专有的调查工具。脚本名称中的 `verify` 不代表只读；部分脚本会连接临时 PostgreSQL schema、调用真实模型或文档提取服务、使用真实 PDF，或写入 `docs/evidence/`。

执行前逐个阅读脚本顶部说明及当前参数；不要批量运行。按系统能力查找入口：

| 能力 | 脚本 |
| --- | --- |
| 入库、提取与脱敏 | `verify-integration.ts`、`verify-input-versions.ts`、`verify-ocr-page.ts` |
| 出题、资料与版本 | `verify-authoring-flow.ts`、`verify-rule-loading.ts`、`verify-rule-versions.ts`、`verify-project-skill-queue.ts` |
| 作答、评分与归档 | `verify-answer-flow.ts`、`verify-independent-score.ts`、`verify-independent-modules.ts`、`verify-generated-cleanup.ts` |
| Codex、模型与资源 | `verify-codex-client.ts`、`verify-codex-isolation.ts`、`verify-domestic-models.ts`、`verify-qwen.ts`、`verify-resource-monitor.ts` |
| 项目目录 | `verify-project-folders.ts` |

历史执行命令和结果保留在 `docs/evidence/`，不作为当前入口索引。模型调用、真实材料处理和业务数据改动仍须符合根 `AGENTS.md` 的授权约束。
