<!-- 文件职责：说明 ALE 第一期的本地预标定试包成果、工作流对应关系与非输入目录边界。 -->
# ALE 第一期

本目录保存 `ALE - 第一期`（工作台项目 ID：`d51246f7-4fac-4687-a6c4-4d5c0348b7e3`）的本地任务包展开结果与第 7 节标准试包输出。本期通过全局材料库加载两个已脱敏多项目 L5 卷宗包，不设本地 `questions/` 扫描目录，`outputs/` 不作为题目来源输入。

## 本期实跑任务与产物对应表

| 任务 ID | 工作流 ID | 来源材料包（源自 Work法律全场景 L5） | 领域划分（`domain / sub_domain`） | 本地第 7 节预备包与动态核验状态 |
| --- | --- | --- | --- | --- |
| `ENG-COST-L5-001` | `ceb226ff-dad1-48cb-aad5-7debb0d6c649` | `ALE-Work-L5-工程项目组合`（6 份脱敏卷宗） | `engineering / construction_settlement_audit` | `CHK-01`–`CHK-05` 全部 `PASS`（`B01=1.0`，`B02=0.0`，10 组等价解与 `M01–M09` 单因子反例实测全过）；`CHK-06`/`CHK-07` 待真实标定标 `SKIP` |
| `FIN-DEBT-L5-002` | `b2f91331-de34-4e37-805e-c48ababe6a1c` | `ALE-Work-L5-交易借贷组合`（7 份脱敏卷宗） | `business_finance / multi_facility_debt_reconciliation` | `CHK-01`–`CHK-05` 全部 `PASS`（`B01=1.0`，`B02=0.0`，10 组等价解与 `M01–M09` 单因子反例实测全过）；`CHK-06`/`CHK-07` 待真实标定标 `SKIP` |

## 产出目录说明

- `outputs/staging/`：由 [`../scripts/delivery.ts`](../scripts/delivery.ts) 展开的单题目录树（`tasks/ENG-COST-L5-001/`、`tasks/FIN-DEBT-L5-002/`）、`check_records_*.json` 及诚实状态清单。
- `outputs/release_pilot_v1/`：由 [`../scripts/batch-package.ts`](../scripts/batch-package.ts) 按规范第 7 节生成的完整 `batch/` 目录（`batch_manifest.json`、`trajectory_stats.csv`、`SHA256SUMS.txt`、`tasks/`、`shared/materials/`）及经 CRC 校验的 `ale_l5_pilot_v1.zip`。
- 工作台第 8 步归档同步产物：由 `archive.ts` + `delivery.ts` 自动写入 `assets/out/附件库/ALE/第一期/<题目>/成果/`。

## 验收边界声明

当前 `release_pilot_v1` 已通过静态结构、五阶段隔离、七要素 Rubric 及本地沙盒 `B01`/`B02`/`B03`/`M01–M09` 动态评分实测；正式提交买方前仍须独立完成容器/VM 镜像 digest 构建、`GPT-6.1-Sol` / `Opus-5.5`（`reasoning_effort = max`）8 次独立标定（保留 1–3 次成功）、至少 1 条 `opus-5` / `gpt-5.6-sol` 真实成功轨迹与防 hack 审计，并经买方书面哈希冻结确认接收。
