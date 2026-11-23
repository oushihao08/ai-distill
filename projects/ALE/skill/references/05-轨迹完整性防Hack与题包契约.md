# 轨迹完整性、防 Hack 审计与第 7 节题包契约

**用途：**指导作者与交付工程师对齐《ALE 数据交付技术规范》第 4、5、7 节的目录结构、8 次难度标定、真实轨迹 Token/轮次精确复算、防 hack 审计（`review/<run_id>.json`）及工作台桥接契约。

---

## 一、第 7 节标准交付树与文件契约

所有文本与结构化元数据统一采用 **UTF-8（LF 换行）**，原生工程、二进制科学数据与媒体保持原格式；**严禁交付 Git LFS 指针文件、软链接逃逸、过期下载链接、`TODO` 占位空文件或 `.DS_Store` / `__pycache__`**。

```text
batch/
  batch_manifest.json              # 批次/任务版本、任务清单、domain/sub_domain/task_family、材料/环境引用、文件路径及SHA256、分布汇总与覆盖率
  SHA256SUMS.txt                   # 覆盖 batch/ 内除自身外的全部交付实物文件
  trajectory_stats.csv             # 每个 run 一行：task_id,run_id,model,status,input_tokens,output_tokens,total_tokens,model_turns,tool_calls
  tasks/<task_id>/
    task_card.json                 # (或 task.toml) 任务契约：task_id、版本、domain/sub_domain、输入、产物合同、启动/复位/评分入口、资源与网络、canary
    instruction.md                 # 面向被测 Agent 的唯一公开任务书（零剧透、零模拟词、明确交付路径与截点）
    environment/
      Dockerfile                   # (Windows/GUI 题用可恢复 VM/快照资产及说明替代)
      env.json                     # 固定镜像 digest 或 VM 快照、OS、软件版本、CPU/GPU/RAM/timeout、allow_internet 及五阶段可见性声明
      requirements.lock            # 精确锁定的语言/系统依赖清单
      input/                       # 初始输入材料（大型跨题共用资产可置于 shared/materials/ 并通过哈希与相对路径引用）
      reset.sh                     # 幂等复位脚本（可执行权限 0755，LF 换行）
    tests/                         # 【Agent 执行期绝对不可见】
      grade.py                     # 可执行离线评分入口（0755，异常显式退出非0报错，正常判分输出标准 grade.json）
      rubric.json                  # 逐项七要素判据、归一化公式、pass_threshold 与 is_key_gate 定义
      reference/                   # 评分比对所需的私有真值、测试向量、Judge 固定模板及反例变异用例（variants/）
    solution/                      # 【Agent 执行期绝对不可见】
      solve.sh                     # 可复现参考求解脚本或分步推导说明（0755，LF 换行）
      artifacts/                   # 真实运行产出的参考原生产物及推导依据
    runs/<model>/<run_id>/         # 最终冻结版本的全部真实运行记录（含全部8次标定 + ≥1条 opus-5/gpt-5.6-sol 成功轨迹）
      run.json                     # 绑定 task_id、run_id、四类版本号、采样参数与预算、起止时间、终止状态、usage 明细与轮次/工具汇总
      trajectory.jsonl             # 未删减、未拼接、未摘要压缩的完整原始消息与工具调用事件流（超长工具输出另存 blobs/ 并给哈希索引）
      artifacts/                   # 该次运行实际收集到的原始产物副本
      grade.json                   # 逐项 expected/observed/score、normalized_score、success、error 及证据路径
    review/<run_id>.json           # 同次运行防 hack 审核记录（绑定 run_id、产物 SHA256、五项防 hack 核查结论与证据）
  shared/
    materials/                     # 跨题共享大型材料包（只存一份，按版本+路径+SHA256引用）
    environments/                  # 跨题共享镜像归档或 VM 基础层（只存一份，按版本+路径+SHA256引用）
```

---

## 二、在 `ai-distill` 工作台出题时的无损桥接约定

当作者在 `ai-distill` 本地工作台（步骤 4 出题会话，交付 `output/result.json`）内执行 ALE 出题时：

1. **遵循当前运行时 `delivery.json` 的 JSON Schema**：
   - `task_name`：写真实专业工单标题（零模拟词、零泄底）；
   - `task_type`：填 `<domain>/<sub_domain>`（如 `business_finance/financial_due_diligence` 或 `law_compliance/litigation_execution_audit`）；
   - `question`：与 `instruction.md` 正文保持逐字一致；
   - `answer_approach`：完整记录四层输入穿透推导、多跳计算过程、依赖删除核验结果及 `1–3/8` 难度控制依据；
   - `reference_answer`：完整呈现各参考产物的核心计算结果、结构化摘要与可复核推导；
   - `answer_requirements`：仅反映本地工作台文字作答器的固定 schema，按 `delivery.json` 填 `{"input_mode": "text", "output_mode": "text", "tools": []}`；**切勿**因此删减 `question`（`instruction.md`）和 `ale_package` 中对 ALE 容器环境、工具与原生产物（`.xlsx`/`.docx` 等）的真实交付要求；
   - `rubric`：与 `tests/rubric.json` 逐项一一对应（`id` = `criterion_id`；`legacy` schema 下填 `{id, criterion, max_score}`，`model_report_v1` schema 下填 `{id, criterion, rule, metadata}`）。
2. **无损挂载完整可执行 `ale_package` 资产（兼容 `legacy` 与 `model_report_v1` 双模式）**：
   - 将完整可执行 JSON 对象（含 `task_card`、`env_spec`、`dockerfile`、`requirements_lock`、`reset_sh`、`rubric_spec`、支持 `--artifacts-dir` 与 `--output` 的离线确定性 `grade_py`、`solve_sh`、含 `.docx` 正文与带 `{formula, cached_value}` 活公式 `.xlsx` `sheets` 的 `reference_files`、`reference_ground_truth` 及覆盖 `B03`/`M01`/`M02`/单因子错误反例的 `variant_fixtures`，结构见[任务包与契约模版](../assets/任务包与契约模版.md)）封装在 `answer_approach` 推导正文末尾的定界块中：
     ```text
     <<<ALE_PACKAGE_JSON
     { ...完整合法 JSON 对象... }
     ALE_PACKAGE_JSON>>>
     ```
     （若当前 `delivery.json` 为 `model_report_v1` 模式，也可同步写入 `rubric[0].metadata.ale_package`。）
   - 归档或导出时，`projects/ALE/scripts/delivery.ts` 会自动提取 `ale_package`（并将纯推导说明分离写入 `solution/derivation_notes.md`），连同冻结输入材料无损展开为标准 `tasks/<task_id>/` 目录树并执行 `verify-task.ts --execute` 动态实测！

---

## 三、第 4 节难度标定与双轨真实轨迹要求

1. **8 次独立标定硬规则**：
   - 标定模型：固定使用 **`GPT-6.1-Sol` 或 `Opus-5.5`**，显式设置 **`reasoning_effort = "max"`**；
   - 事前冻结：模型精确版本（如 snapshot 日期号）、harness 版本、系统提示词与工具集、采样参数、单次时间与 token 预算全部事前固定写入 `run.json`；
   - 干净独立：预先编号 `run_01` 至 `run_08`，每次执行前运行 `reset.sh`，**不共享任何历史上下文、中间缓存或产物，严禁任何人工提示或中途干预**；
   - 全量保留：**8 次记录必须全部交付**，严禁挑高分或删掉正常失败重跑！仅当具备明确日志证据的基础设施故障（如宿主机断电、API 503 网关崩溃且未进入模型状态）才可标记 `infra_error` 排除并补跑 `run_09_repl_01`，且**原故障记录必须一并保留备查**；模型超时、爆 token 预算或未解出均计为**正常失败（`success: false`）**；
   - 准入区间：8 次有效尝试中 `success == true` 的次数必须严格为 **`1`、`2` 或 `3` 次**（通过率 `12.5%`、`25.0%` 或 `37.5%`）。`0/8` 或 `4–8/8` 一律不准入合格净量；任何影响结果的题面/环境/参考/评分修改后，旧 8 次标定作废，必须全量重跑 8 次。
2. **额外完整成功轨迹硬规则（第 1 节）**：
   - 每题还必须至少交付 **1 条来自 `opus-5` 或 `gpt-5.6-sol` 的真实完整成功轨迹**（`success == true` 且防 hack 审核通过）；
   - **严禁**拿 `solution/solve.sh`（oracle 参考脚本）的执行日志冒充模型轨迹，该轨迹也**不替代**上述 8 次标定。

---

## 四、第 5 节轨迹 Token 与轮次精确复算口径

`run.json` 与 `trajectory_stats.csv` 中的每一项统计数字，必须能由 `trajectory.jsonl` 内逐次模型 API 调用的原始 `usage` 响应精确复算：

| 指标 | 精确计算定义（严禁估算或拍脑袋填 0） |
| --- | --- |
| `input_tokens` / `output_tokens` / `total_tokens` | 按本次 Agent 循环内**逐次模型调用的原始 `usage` 累加**；若 API 返回含 `cache_read_tokens`、`cache_creation_tokens`、`reasoning_tokens`，必须在 `run.json.usage_breakdown` 明示其与 `input_tokens`/`output_tokens` 是“已包含在内（included）”还是“额外单列（disjoint）”，**严禁重复累加，缺失字段填 `null` 严禁填 `0`** |
| **`model_turns`** | **一次模型响应计 `1` 轮**；工具执行返回消息**不计轮**；同一轮模型响应中发出的多个并行工具调用**不额外加轮** |
| **`tool_calls`** | 全程模型实际发出的工具调用总次数（同轮并行调用 N 个工具则计 `+N`） |
| **Judge 与基建重试隔离** | 评分阶段 LLM Judge 的 token 用量单独记入 `grade.json.judge_usage`，基建故障重试单独记入 `infra_runs`，**严禁混入 Agent 的 `run.json` 用量** |
| **批次分布汇总** | 按题目及模型，分别对 `success == true`（成功）和 `normal_failure`（正常失败）两组计算：`count`、`mean`、`P50`、`P90`、`max`，并在 `batch_manifest.json` 显式注明分位数算法（统一默认线性插值法 `linear` / NumPy `method="linear"`） |

- **原始记录与转换件双交铁律（第 7 节）**：若运行底座产生自有轨迹格式（如 Codex `events.jsonl` 或供应商原生响应流），可保留原有 schema 或转换为统一 `trajectory.jsonl`，但**必须同时交付转换件、未删减原始记录及显式字段映射说明（`trajectory_schema_mapping.json`）**，严禁在转换中丢失暴露的推理链、并行工具调用 ID/返回全文或收集产物关联。

---

## 五、防 Hack 审计（`review/<run_id>.json`）五项必查清单

每条申报 `success == true` 的运行轨迹，均须独立生成 `review/<run_id>.json`，逐项核验并附证据定位：

1. **言行果分四合一验证**：Agent 最终回复陈述、中间工具调用真实返回（非伪造 echo）、收集到的 `artifacts/` 实际内容及 `grade.json` 得分四者严丝合缝，无“工具报错却声称成功”或“未算出数字却在最终文件凭空写出真值”。
2. **离线复评幂等验证**：将保存的 `runs/<model>/<run_id>/artifacts/` 重新送入干净评分容器运行 `tests/grade.py`，复评得分与 `success == true` 完全重现。
3. **零越界获取真值验证**：扫描全部命令执行、文件读取与网络请求参数，确认零读取宿主机挂载外路径、零检索本题 `canary`/特征题干、零翻查 Git reflog/commit 历史、包缓存或跨会话残留。
4. **零篡改评分与后端绕过验证**：确认零修改测试脚本/`grade.py`/`rubric.json`/环境变量，零绕过授权业务 API 直接篡改底层 SQLite/PostgreSQL 状态库或伪造成功标志文件。
5. **漏洞披露与模型利用区分**：若质检发现评分器存在潜在漏洞，须先区分“静态发现漏洞”与“轨迹中模型在允许工具下实际可达并利用了该漏洞”；确认存在答案泄露、轨迹拼接伪造或奖励投机的 run 记为无效，修复评分器后重跑标定，**严禁仅删掉异常失败记录来美化通过率**。
