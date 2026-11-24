# 模型档位离线评测脚本（`scripts/evaluation/`）

适用范围与读者：对比不同模型或推理强度（如 `low` vs `medium`）在材料脱敏与分册整理任务上质量差异的研发人员。

## 职责与数据流

从数据库只读加载已提取完成的文档页（`library_documents`），调用 `prepareAgentLibraryMaterials()` 在本地隔离目录 `.storage/evaluation/` 下运行评测并输出 JSON/文本对比产物，**绝不写入数据库正式业务表**。

## 关键文件

| 文件 | 用途与入口 | 输出位置与边界 |
| --- | --- | --- |
| `eval-low-vs-medium.ts` | 对比 `gemini-3.8-flash` 在 `low` 与 `medium` 推理强度下的脱敏与分册整理质量 | 产物写 `.storage/evaluation/low-vs-medium/`；发起真实模型调用，运行前须获明确授权 |
| `eval-parallel-4.ts` | 并发执行指定 4 个同源材料包的 `low` 档位脱敏评测 | 产物写各自子目录 `low-result.json`，不改数据库记录 |

## 维护边界

- 评测脚本仅用于实验对比，不替代正式 `POST /api/material-library/revisions/:id/jobs` 或 `/prepare` 流程。上级目录说明见 [`../README.md`](../README.md)。
