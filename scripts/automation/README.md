# 期次自动化流水线脚本（`scripts/automation/`）

适用范围与读者：维护特定历史期次材料入库、脱敏与整理自动化编排脚本的开发者。

## 职责与入口

存放面向固定期次目录的专项批处理流水线脚本。通用日常批量调度优先使用服务端 `dispatch-batches`（[`server/batch-dispatch/README.md`](../../server/batch-dispatch/README.md)）或 CLI `library batch plan/run`、`project materials onboard`。

## 关键文件

| 文件 | 用途与运行入口 | 副作用与边界 |
| --- | --- | --- |
| `phase9-materials-intake.ts` | 豆包高经济价值第九期材料流水线薄入口，直接加载并运行 `phase9-pipeline-runner.ts` | 同下 |
| `phase9-pipeline-runner.ts` | `bun scripts/automation/phase9-pipeline-runner.ts`：扫描第九期来源目录，按 API（提取）与 Agent（脱敏、整理）槽位推进，支持 MinerU 连续失败切 `glm-ocr` 及本地对账台留证 | 会发起真实提取/Agent 任务并写入本地对账目录；未经明确授权不得在生产环境盲跑 |

## 维护边界

- 本目录脚本绑定第九期固定 `PROJECT_ID` 与目录，不作为跨项目通用入口。上级工具总览见 [`../README.md`](../README.md)。
