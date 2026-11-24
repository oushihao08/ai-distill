<!-- 文件职责：说明 ALE 项目专属定制步骤的职责、锚点顺序、防剧透/M10 门控、8+3 并发标定状态机与隔离边界。 -->
# ALE 专属定制步骤（`projects/ALE/custom-steps`）

面向 ALE 项目维护者与工作台定制步骤调度层。本目录封装仅对主项目 `ALE` 生效的三道出题前后专属步骤，通过 `server/custom-steps/index.ts` 显式白名单注册，不导入其他项目目录，也不影响豆包或 Work 项目。通用定制步骤契约以 `server/custom-steps/contract.ts`（`MAX_ALLOWED_PARALLEL_SUBRUNS = 12`）与 `server/custom-steps/jobs.ts` 为唯一权威来源。

## 步骤与锚点清单

| `step_key` | 锚点位置 | 运行模式与通道 | 职责与门控 |
| --- | --- | --- | --- |
| `ale_pre_authoring_lock` | `before` 步骤 `4`（`#1`） | `inline_before_gate`（`internal`，0 槽位） | 出题派发前校验来源材料非空，计算确定性 DOCX 二进制指纹并锁定挂载进 `environment/input/附件N.docx` 的精确文件名与 SHA-256 映射写入冻结元数据 `custom_before_gates` |
| `ale_verify_gate` | `after` 步骤 `4`（`#1`） | `queued_single`（`internal`，0 Agent 槽） | 展开沙盒 `staged/tasks/<task_id>/` 预备包，实跑 `B01`/`B02`/`B03` 动态基线与 `M01`–`M09` 单因子反例，并执行 **Rubric 70/30 关键门控平衡审计**、**`instruction.md` 防剧透宽表拦截**与 **`M10` 表层诱饵反例（`shallow_decoy_trap`）检查**；阻断步骤 `8` 归档（不可跳过） |
| `ale_calibrate_8plus1` | `after` 步骤 `4`（`#2`） | `queued_subruns`（`agent`，每次子运行占 1 个 Agent 槽，`max_parallel_subruns = 12`） | 隔离作答难度标定与示范轨迹采集：正式 `formal_8plus1` 默认启用 **`8 + 3`（8 路标定 + 首波 3 路示范 = 11 路）并发同跑**，支持显式退回两波模式及 `sample_3` / `sample_5` 抽测档位；具备超上限/必败/故障早停撤单、按波补发与离线秒级重评；阻断步骤 `8` 归档（支持显式 `pilot_skip_optional` 试包豁免） |

## 关键门控与 `8 + 3` 并发状态机

### 1. `ale_verify_gate` 防误杀、防剧透与 `M10` 压难门禁

除 `materializeAleTaskFromDraft(..., executeDynamic: true)` 执行静态契约、`B01`–`B03` 基线与 `M01`–`M09` 单因子反例外，`verify-gate.ts` 额外执行两类硬筛：

- **Rubric 门控分层审计（`auditAleRubricGateBalance`）**：当评分项总数 `≥ 4` 且全部被设为 `is_key_gate: true` 时拒绝通过（防止单点边缘小瑕导致 `0/N` 整题归零，要求按约 70/30 保留至少 1 条非一票否决细节项；仅显式传 `allow_all_key_gates: true` 可豁免）。
- **防剧透与 `M10` 表层诱饵审计（`auditAleAntiSpoilerDesign`）**：
  - 拦截 `instruction.md` 单处反引号枚举 `> 16` 个固定过程字段的宽表说明书式剧透（仅允许锁定 `6–12` 个终点业务结果键；`allow_wide_schema: true` 可豁免）。
  - 当存在 `tests/reference/variants/manifest.json` 时，强制要求包含 `kind === "shallow_decoy_trap"`（如 `M10_shallow_decoy_trap`）表层诱饵仿真反例（`allow_without_decoy_variant: true` 可豁免），防止模型轻信表层汇总导致 `8/8` 过易报废。

### 2. `ale_calibrate_8plus1` 的 `8 + 3` 并发策略与闭环转移

`resolveAleCalibrationPolicy()` 与纯状态机 `planAleCalibrationSubRuns()` 控制子任务规划：

- **并发开关 `concurrent_demo_with_calibration`**：
  - 当 `demo_required > 0`（如默认 `formal_8plus1`：`8` 轮 `gpt-6.1-sol` 标定要求通过 `1–3` 次 + `1` 条 `gpt-5.6-sol` 示范轨迹，`demo_parallel = 3`，`demo_max_attempts = 6`）时默认为 `true`，首轮直接将 `cal_run_01..08` 与首波 `demo_run_01..03`（共 `11` 路）一并规划入队。
  - 显式传入 `concurrent_demo_with_calibration: false` 时退回「先跑完 8 轮标定、过线后再发 3 路示范」的两波串行阶段模式。
  - `sample_3` / `sample_5` 因 `demo_required === 0` 自动置为 `false`，仅派发 `cal_run_01..03` 或 `01..05`。
- **状态边界与早停/补发规则**：
  - **基建故障中止**：任一子任务 `status === 'failed'`（CLI/环境异常，注意模型未解出题仍为 `status === 'succeeded'` 且 `result.run_success === false`）时，立即返回 `early_stop_failed` 且 `cancel_waiting_sub_runs: true`，撤掉所有 `waiting` 子任务。
  - **标定早停与未过线撤单**：标定通过数超出 `max_pass`（如 4 连过）、开启 `early_stop_impossible` 后剩余全对仍低于 `min_pass`、或 8 轮全部跑完但通过数不在 `[min_pass, max_pass]` 内时，立即返回 `early_stop_failed` 且 `cancel_waiting_sub_runs: true`，同步取消未启动的 `cal_run` 与 `demo_run`。
  - **示范先过等待标定完结**：若并发 `demo_run` 已达到 `demo_required`，但 8 轮标定尚未全部完成，绝不提前判整步成功；停止补充任何新 `demo_run` 并返回 `wait`，直至 8 轮标定全部完结并核验合格。
  - **标定合格后的示范结算与按波补发**：8 轮标定合格后，若 `demoPassCount >= demo_required` 立即返回 `succeeded` 并 `cancel_waiting_sub_runs: true`；若当前波次仍有运行/排队中的 `demo_run` 则 `wait`；若当前波次全部未通过且总尝试 `< demo_max_attempts`，自动补发下一波（最多 `demo_parallel` 路，总计不超过 `demo_max_attempts`）；耗尽 `demo_max_attempts` 仍未达标则返回 `failed`。
- **离线秒级重评与返修诊断**：传入 `regrade_only: true` 时复用沙盒已存 `runs/<model>/<sub_run_key>/artifacts` 调用 `tests/grade.py` 重算（0 模型调用；此前未实际生成产物的并发示范槽位按未通过计，不触发基建崩溃）；未达标时由 `buildAleCalibrationRepairEvaluation()` 自动聚合并持久化 `custom_repair_eval_v1` 结构化 JSON。

## 文件说明与维护边界

| 文件 | 职责与公开入口 |
| --- | --- |
| `index.ts` | 导出 `ALE_PROJECT_KEY`、`ALE_CUSTOM_STEPS` 与 `registerAleCustomSteps()`，声明三道定制步骤的锚点、通道与并发上限 |
| `pre-authoring-lock.ts` | 实现 `runAlePreAuthoringLock()`，出题前冻结输入映射与哈希 |
| `verify-gate.ts` | 实现 `executeAleVerifyGate()`、`prepareStagedMaterialsForAleDraft()`、`auditAleRubricGateBalance()`、`auditAleAntiSpoilerDesign()` 与 `buildAleVerifyRepairEvaluation()` |
| `calibrate-8plus1.ts` | 实现 `resolveAleCalibrationPolicy()`、`planAleCalibrationSubRuns()`、`executeAleCalibrationSubRun()` 与 `buildAleCalibrationRepairEvaluation()`，复用 `../scripts/calibrate.ts` 的隔离执行与重评原语 |
| `custom-steps.test.ts` | 覆盖前置输入锁、70/30 门控分层、防剧透与 `M10` 门禁、`sample_3`/`sample_5`/`formal_8plus1` 的 `8+3` 同发、两波回退、早停撤单、等待闭环、按波补发与返修评价 JSON 校验 |

- 所有运行时产物仅写入经 `realpath` 校验的 `.storage/<workflow_id>/custom-steps/ALE/` 沙盒目录，严禁写入 `projects/ALE/skill/`、`projects/ALE/materials/` 或跨项目引用。
