<!-- 文件职责：说明 ALE 项目从单题出题、动态反例验证、8次难度标定到第 7 节标准批次交付的七步流水线与脚本入口。 -->
# ALE 七步标准交付流水线与工具说明

本目录实现《ALE 数据交付技术规范 · 需求沟通v1》第 1–7 节的单题展开、全量质检、单因子反例验证与标准 `batch/` 批次打包，同时无缝接入 `ai-distill` 工作台第 8 步归档协议。

## 一、脚本职责一览

| 文件 | 公开入口与用途 | 副作用与边界 |
| --- | --- | --- |
| [`contracts.ts`](contracts.ts) | 7 大领域配额常量、9 字段 `AleCheckRecord`、原始轨迹 `model_turns`/`tool_calls`/Token 精确复算、线性插值分位数（P50/P90）与 LFS/占位检测 | 纯计算函数库，零 I/O |
| [`ale_grader_lib.py`](ale_grader_lib.py) | 标准公共判分底座库（`ExcelEvaluator` 双引擎公式重算与微扰动 `probe`、`DocxExtractor` 多列表格与枚举提取、`GradeReporter` 第 7 节报告生成） | 由 `delivery.ts` 自动打入私有 `tests/ale_grader_lib.py`，Agent 执行期不可见 |
| [`office_lint.py`](office_lint.py) | 零业务知识通用格式/公式语法与重算回显工具（回显 `.xlsx` 各表维度、公式重算值、`#REF!/#NAME?/循环引用` 错误及 `.docx` 表格行列预览） | 由 `delivery.ts` 自动打入公开 `environment/tools/office_lint.py`，并在 `calibrate.ts` 沙盒只读挂载 |
| [`archive.ts`](archive.ts) | 工作台第 8 步归档准备入口：校验并读取本题冻结来源附件（共享材料库或旧目录）装填 `input.attachments`，`readConfig()` 返回 `null` 不占 Agent 槽位 | 由 `project-delivery.ts` 动态加载，不向子进程传凭证 |
| [`delivery.ts`](delivery.ts) | 工作台第 8 步自动归档子进程入口；同时支持 `--from-draft` CLI 将含 `ale_package` 的草稿与材料展开为 `tasks/<task_id>/` 并复用 `server/document-generation` 生成真实 `.docx` 与活公式 `.xlsx` | 仅写指定输出目录；自动执行动态基线与单因子反例实测，未执行的模型标定步骤如实标 `SKIP` |
| [`verify-task.ts`](verify-task.ts) | 单题全量质检器：检查文件齐备/UTF-8/LF/可执行权限/零LFS、契约对齐、五阶段真值隔离、`rubric.json` 七要素与门控、动态基线与单因子反例（`--execute`）、8次标定 `1–3/8` 与 `opus-5`/`gpt-5.6-sol` 防 hack 审查（`--require-runs`） | 默认纯只读；`--execute` 在系统临时沙盒运行 `grade.py` 后自动清理 |
| [`calibrate.ts`](calibrate.ts) | 本地 Codex CLI 隔离标定与轨迹采集器：执行输入与环境预检（`--dry-run`），按五阶段隔离启动 `codex exec`（`gpt-6.1-sol` / `gpt-5.6-sol`，`reasoning_effort=max`），转换 `trajectory.jsonl` 与 `run.json` 并离线调用 `tests/grade.py` 输出 `grade.json` | `--dry-run` 零副作用；真实执行会调用本机 ChatGPT 套餐配额并写入目标题包 `runs/` |
| [`batch-package.ts`](batch-package.ts) | 第 7 节批次组包器：逐题强校验、拦截重复/同构题与超配额领域、归集 `tasks/` 与 `shared/`、生成 `trajectory_stats.csv`、`batch_manifest.json`、`SHA256SUMS.txt` 及 UTF-8 `.zip` | 目标已存在时拒绝覆盖；任一题目存在未关闭缺陷即中止组包 |
| [`grader-and-lint.test.ts`](grader-and-lint.test.ts) | `ale_grader_lib.py`、`office_lint.py`、`delivery.ts` 与 `calibrate.ts` 完备单元与集成测试 | 临时沙盒运行，自动清理 |

---

## 二、ALE 七步全链路交付 SOP

### 步骤 1：领域配额核查与异构立意
1. 对照 [`../skill/references/01-领域规划与防同构立意.md`](../skill/references/01-领域规划与防同构立意.md) 确定 `domain / sub_domain / task_family`，确保域内各 `sub_domain` 均匀分布且不超单域上限（7 大核心域 200/100 条，其他域 ≤50 条）。
2. 为本题生成专属私有 `canary`（`ALE-CANARY-<DOMAIN>-<TASK_ID>-<HEX>`），确认非换皮同构题；若复用 `shared/materials/` 或 `shared/environments/`，记录版本号与哈希引用。

### 步骤 2：任务包、隔离环境与参考原生产物构建
1. 按 [`../skill/SKILL.md`](../skill/SKILL.md) 完成四层输入穿透、2–3 跳约束耦合设计与六列双向追溯矩阵核查（零隐藏义务、零剧透、零模拟词）。
2. 构建 `tasks/<task_id>/`（或由工作台出题 `result.json` 经 `delivery.ts` 展开）：
   ```sh
   bun projects/ALE/scripts/delivery.ts \
     --from-draft /绝对路径/result.json \
     --materials-dir /绝对路径/输入材料目录 \
     --out /绝对路径/输出目录 \
     --execute
   ```

### 步骤 3：正式环境动态基线、`no-op` 与九类单因子反例验证（第 6 节）
在声明的干净容器/VM 环境中运行 `verify-task.ts --execute`：
```sh
bun projects/ALE/scripts/verify-task.ts /绝对路径/tasks/<task_id> --execute --out check_records.json
```
必须同时满足：
- `B01` 参考成品基线：确定性评分 `== 1.00`（连续专业评分 `>= 0.90`），全部 `is_key_gate` 通过，`success == true`；
- `B02` 空提交 `no-op`：`normalized_score == 0.0` 且 `success == false`；
- `B03` 合法等价解：正常通过零误罚；
- `M01` 骨架/表头 & `M02` 硬编码常量/伪造数据：`normalized_score <= 0.20` 且 `success == false`；
- `M03–M09` 各单因子变异：目标 `criterion` 精准失分，无关独立项保持不变，破坏关键约束则 `success == false`。

### 步骤 4：8 次独立黄金难度标定（第 4 节）
1. 冻结题面、环境镜像 digest、参考解与 `tests/`；配置 `GPT-6.1-Sol` 或 `Opus-5.5`（`reasoning_effort = max`），预编号 `cal_run_01`–`cal_run_08`。
2. 每次执行前运行 `environment/reset.sh`，干净状态无上下文共享、零人工干预跑满 8 次，落盘完整 `run.json`、`trajectory.jsonl`、`artifacts/`、`grade.json`。
3. 核验有效成功数：**仅保留成功 1、2 或 3 次（12.5% / 25% / 37.5%）的任务**。若为 `0/8` 或 `4–8/8`，按 Skill 调校矩阵修订题包并**全量重跑 8 次**（严禁挑有利结果或删正常失败记录）。

### 步骤 5：示范模型真实成功轨迹采集（第 1 节）
使用 `opus-5` 或 `gpt-5.6-sol` 在同一冻结环境下采集**至少 1 条真实完整成功轨迹**（存入 `runs/<model>/<run_id>/`，严禁拿 `solve.sh` / oracle 日志冒充）。

### 步骤 6：全量成功轨迹防 Hack 审计与单题封签（第 5 节）
1. 对每条 `success == true` 的轨迹（含标定成功轮与示范成功轮）执行离线产物重评、言行果分四合一核对、越界命令与 `canary` 扫描，写入 `review/<run_id>.json`（`verdict: "CLEAN_PASS"`）。
2. 运行完整带轨迹门禁的单题校验（退出码须为 `0`）：
   ```sh
   bun projects/ALE/scripts/verify-task.ts /绝对路径/tasks/<task_id> --execute --require-runs
   ```

### 步骤 7：第 7 节标准 `batch/` 组包、双端哈希核验与买方冻结接收
1. 编写批次输入清单 `batch_spec.json`，执行组包器：
   ```sh
   bun projects/ALE/scripts/batch-package.ts /绝对路径/batch_spec.json
   ```
2. 组包器自动输出：
   - `batch/batch_manifest.json`（含去重净量、各 `domain/sub_domain` 统计、标签覆盖表、线性插值分位数分布汇总、字段覆盖率及全文件哈希）
   - `batch/trajectory_stats.csv`（逐 run Token 与轮次/工具明细）
   - `batch/SHA256SUMS.txt`（覆盖除自身外全部实物文件）
   - `batch/tasks/<task_id>/...` 与 `batch/shared/{materials,environments}/...`
   - `<batch_id>.zip`（自动通过 ZIP CRC 与内外一致性校验）
3. 提交买方执行技术复核，**双方书面确认并冻结哈希后方为正式接收**（供方自标 `final` 不触发接收）。
