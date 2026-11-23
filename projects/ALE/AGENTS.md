<!-- 文件职责：约束 AI 与维护者在 ALE 项目目录中的出题、环境构建、评分、标定与交付边界。 -->
# ALE 项目：AI 协作与工作事实

适用于 `projects/ALE/` 主项目及各期工作流。本文件说明本地规则来源、Skill 入口、执行契约与验证边界；项目状态、题目数量及运行结果须查当前工作台 API 或实际交付目录，不能从本文推断。

## 规则与入口导航

- **项目权威需求基线**：[`materials/ALE数据交付技术规范.md`](materials/ALE数据交付技术规范.md)（源自《ALE 数据交付技术规范 · 需求沟通v1 · 2026-10-19》100% 逐字转换稿）。资源预算、正式签约验收条款及训练评测集协议以买方书面确认为准。
- **Agent 出题与任务包构建方法**：从 [`skill/SKILL.md`](skill/SKILL.md) 按其五阶段导航读取 `skill/references/` 与 `skill/assets/`。`materials/` 与 `skill/` 参与任务指纹计算，**禁止**在 `skill/` 或题目附件目录内放置临时文件、运行日志或无关说明。
- **交付与质检工具链**：见 [`scripts/README.md`](scripts/README.md)。
  - 工作台第 8 步归档钩子：`scripts/delivery.ts`（由 `server/publishing/project-delivery.ts` 按项目名 `ALE` 自动识别并独立子进程调用）。
  - 单题全量质检与单因子反例核验：`scripts/verify-task.ts`。
  - 第 7 节标准 `batch/` 批次组包、轨迹统计与 SHA-256 签名：`scripts/batch-package.ts`。

## 六道硬性状态边界（防止误报完成度）

报进度与写质检记录时，必须严格区分以下六个独立状态，**严禁**用前序成功冒称后续通过：

1. **题包与环境静态成稿**：`instruction.md`、`task_card.json`、`environment/`、`solution/`、`tests/` 文件齐备且通过契约/隔离静态检查。
2. **正式环境动态基线与单因子反例通过**：在真实容器/VM 中实跑 `reset.sh` → 参考解达满分（或连续评审 `≥ 0.90` 且全部 `is_key_gate` 通过）→ `no-op = 0` → 骨架/常量伪造 `≤ 0.20` 且 `success = false` → 各单因子反例精准失分 → 合法等价解不误罚（只读源码或自报得分不算动态检查完成）。
3. **8 次难度标定合格**：最终冻结版本经 `GPT-6.1-Sol` 或 `Opus-5.5`（`reasoning_effort = max`）干净状态独立运行 8 次（`run_01`–`run_08` 全量保留），成功次数严格落在 **1–3 次（12.5% / 25% / 37.5%）**；`0` 次或 `4–8` 次均不合格；任何影响结果的修订使旧标定立即失效。
4. **模型成功轨迹与防 hack 审计齐备**：除 8 次标定外，另交至少 1 条 `opus-5` 或 `gpt-5.6-sol` 的真实完整成功轨迹（严禁用 oracle/参考脚本日志替代）；全部申报成功轨迹均通过 `review/<run_id>.json` 防 hack 核验、保存产物复评分一致且 `canary` 零泄露。
5. **批次组包与哈希校验完成**：生成 `batch/`（`batch_manifest.json`、`trajectory_stats.csv`、`SHA256SUMS.txt`、`tasks/`、`shared/`），无 LFS 指针、无占位文件、无软链逃逸，ZIP 内外 SHA-256 双向核验一致。
6. **买方书面哈希冻结接收与训练效果验收**：双方冻结哈希并书面确认后才算接收；供方自称 `final` 不触发接收；训练前后独立评测集涨分验收另按协议执行。

## 安全与红线

- 严禁将 `tests/reference/`、`solution/`、`tests/rubric.json`、`tests/grade.py` 或评分私有资产挂载/打入 Agent 执行期可见区。
- 严禁修改测试/评分器、伪造运行轨迹、删减正常失败记录（凑 1–3/8 通过率）或把缺失 token 填为 `0`。
- 不在仓库提交 `.env`、API 密钥、私有模型凭据或未授权商业机密。
