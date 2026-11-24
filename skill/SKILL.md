---
name: ai-distill-workflow
description: Use when the user asks to inspect, execute, or improve ai-distill workflow throughput, worker/API scheduling, long waits, batch processing, material onboarding/redaction/preparation, authoring, project custom-steps (ALE verification/calibration), answering, scoring, acceptance, archiving, Feishu delivery, Siriser five-piece, or Skill Dependency packaging. Use browser-skill for actual external webpage operations.
---

# ai-distill 工作流操作规则

## 1. 入口与硬边界

- **决策优先级**：`用户当前要求 > 本次任务约定 > 项目配置与项目 Skill > 本文件默认流程`。
- **调用入口**：本机工作流默认直接调用 `http://127.0.0.1:3700` HTTP API；用户明确要求命令行时使用 CLI（按前缀查精确旗标：`bun run ai-distill <前缀> --help`，如 `library --help`、`custom-step --help`、`feishu --help`；详情见 [CLI 指南](../cli/README.md)）。
- **禁令**：严禁直连 PostgreSQL 或 SQLite 读写业务数据；未获明确授权不重启服务、不跑迁移、不改模型/阈值/提示词/规则文件、不删除项目或题目。写请求超时或断连**绝不换键盲重发**，先按原 ID / `request-key` 核实状态。
- **职责分离**：本目录规定工作流调度；`projects/<项目>/skill/` 规定项目出题内容（仅出题作者读取，不注入被测作答或独立评分）。定位代码与路由读 [MAP.md](MAP.md)，分层边界读 [ARCHITECTURE.md](ARCHITECTURE.md)，远程隧道读 [REMOTE.md](REMOTE.md)。

## 2. 执行通道选择

| 通道 | 适用阶段与场景 | 容量与调用方式 |
| --- | --- | --- |
| `agent` | 本地 Codex/AGY 执行 `redact`（`aliases`）、`prepare`、步骤4出题、项目定制步骤（如 ALE `queued_subruns`）、步骤6 Agent评分、手动返修建议、项目Skill生成 | 读 `/api/system/concurrency-settings` 与 `/api/system/execution-queue` `capacity.agent`；单次出题可传 `authoring_settings:{provider,model,reasoning_effort}` |
| `api` | PDF/DOCX 提取、显式 API 脱敏（`redact`）与 API 材料整理（`prepare`）、步骤5模型作答、步骤6 API评分 | 读 `capacity.api`；与 `agent` 独立消费池，槽位不可互转。HTTP 传 `api_settings:{provider,model,...}`，CLI 用 `--api-provider --api-model` 或 `--api-settings-file`（查模型目录用 `GET /api/llm-api/models` / CLI `models api-catalog`） |
| `web` | 经已登录浏览器自动跑 `prepare`（deepseek）或步骤4出题（deepseek/gemini） | 独立 6 槽位 `capacity.web`（需 064 迁移）；HTTP 传 `web_settings`，CLI 用 `--web` 及 `web status/doctor/login/close`；不支持自动 `redact` |
| `offline` | 人工网页交互作业台（`redact` / `prepare` / `author` 导出每任务 zip + 对账台，贴回 `reply/reply-N.md` 校验入库） | 仅 CLI 本地工具 `offline export/import/status`（需用户指定命令行且共用 `STORAGE_DIR`） |
| `remote` | SSH 隧道交服务器跑**旧工作流**入库/`declared_redacted` 兼容处理或**无钩子题目**模型作答 | 仅用户要求命令行且满足 [REMOTE.md](REMOTE.md) 前置时用 `remote material|answer`；不跑全局库本地 blob、出题、评分或归档 |

> 仅限 CLI 的本地文件工具（无对应 HTTP 导出路由）：`export failed`、`export review`、`offline`、`feishu local-sync`、`library documents export`。未获命令行要求时说明接口边界，不暗自切 CLI。

## 3. 材料库与期次不变量

1. **上传前检查与预处理**：上传或派发提取前检查单文件大小与 `pdfinfo` 页数（核对 `server/validation.ts` 与 OCR 限制）。DOC/WPS/OFD 转换及超限 PDF 切割复用 `prepareLibraryFiles()`（CLI：`library files prepare`，见 [预处理说明](../cli/README.md#ofd与超限pdf上传前准备)），生成新清单后再入库；全局材料库上传**不自动切割**，禁止用旧 `sync-folder` 替代。
2. **原子提取入库**：新材料经 `POST /api/material-library/imports`（CLI：`library import`）提交，全部提取通过才发布正式 `package_id`/`revision_id`（旧 `POST /packages` 已停用返回 410）；已有包新版本用 `POST /packages/:id/revisions`。
3. **处理模式、加载与高效建题**：先读 `GET /api/projects/:id/material-processing`（CLI：`project materials mode`，`aliases` 默认整包化名，`original` 使用成功提取原文，`mask` 仅历史只读；已加载汇总读 `loaded-materials/summary` / CLI `project materials summary`）。项目材料任务必传 `project_id`。建题快照永久冻结来源与可见文书，后续改期次设置不影响旧题。主项目 `project_material_uses` 跨期防重；退回 `in_use` 仅用于原期返修，不释放跨期占用。**CLI 一步加载与建题**：用户要求命令行时，优先用 `bun run ai-distill project materials onboard --project <期次UUID> (--package <包UUID> | --packages <UUID,...> | --count <N> [--q 词] [--require-prepared] | --file <清单.json>) [--out <回执.json>] --json` 一步完成按期次模式自动选版、>10 页门槛校验、期次加载与确定性幂等建题，直接将返回的 `workflow_ids` 传入 `step dispatch author_question`（仅批量加载加 `--load-only`；`project materials load` 省略 `--redaction/--revision` 时同样自动选版）。
4. **单包题量规则**：由具体项目规则决定。**Work法律全场景固定一包一题**（出题前必读 [Work规则](../projects/Work法律全场景/AGENTS.md) 与 [Work Skill](../projects/Work法律全场景/skill/SKILL.md)）；不推广至其他主项目。
5. **可选材料整理（`prepare`）**：基于成功脱敏或提取生成总摘要、逐份可见性与候选组合（[CLI整理说明](../cli/README.md#材料整理)）。重跑传 `force:true` + 新 `request_key`；单次默认预算 30 分钟，到期停止不自动重试；缺失或失败不阻断建题。未归档且无活动任务的既有题目在重跑整理成功后，可通过 `POST /api/workflows/:id/material-scope`（CLI：`workflow material-scope sync`）同步最新 `material_scope`。CLI 自然语言批量筛选派发用 `library batch plan/run`（多条件为 **AND** 关系）。

## 4. 分页与轻量读取契约（严禁全表拉取充当目录）

| 场景 | 推荐轻量接口 / 参数 | 默认与上限 / 翻页依据 |
| --- | --- | --- |
| 取全期工作流 ID（如 `--all`） | `GET /api/projects/:id/workflow-ids?kind=question&page=1&page_size=500` | 最大 1000/页，按 `has_more` 翻页 |
| 最近 N 题或指定 ID 交付预检 | `GET /api/projects/:id/questions?page=1&limit=100` 或 `?ids=UUID,...` | `limit` 1–1000（按创建时间倒序，非完成时间）；`ids` 最多 1000 |
| 项目详情工作流分页 | `GET /api/projects/:id?workflow_page=1&workflow_page_size=100` | 单页最大 500，看 `workflow_has_more`；步骤4全期未出题就绪数看 `steps[].unauthored_ready` |
| 单题/批量步骤状态与归档回执 | `GET /api/workflows/:id?view=status`（CLI：`question show --status`）；批量 `GET /api/projects/:id/workflow-status?ids=...` | `workflow-status` 每批 <=100（CLI 3 并发拉取）；**工作流详情仅 `?view=status` 省略大字段** |
| 轮询 attempt 状态 | `GET /api/attempts/:id?wait_ms=30000&view=status`（CLI `attempt wait` 默认轻量） | 单次 `wait_ms` <=30s；看正文用 `attempt show` 或 `wait --full` |
| 材料库包/导入/版本/整理列表 | `/packages?page=1&page_size=50`（看 `total_count`）；`/imports`、`/revisions`、`/loaded-materials`、`/material-uses`、`/events` 均支持 `page` & `page_size` | 仅判断是否有整理成果必加 `preparations?summary_only=true&page_size=1`（CLI `--summary-only`）；脱敏仅看校验报告用 `redactions/:id/preview?metadata_only=true`（CLI `--metadata-only`） |
| 成果列表与导出历史 | `GET /api/results?page=1&page_size=100&q=&publication=all|archived|pending`；`/exports?page=1&page_size=100` | 单页最大 500，看 `has_more` |
| 本机执行队列与多实例监控 | `GET /api/system/execution-queue`（CLI：`queue show`）；`GET /api/monitor[?source=...]`（CLI：`monitor sources` / `monitor show`） | 队列默认仅返回活动与待核实项；查终态历史加 `?include_history=true`（CLI `--history`） |

## 5. 步骤身份、评测封存态与项目定制步骤

稳定步骤身份以 `shared/step-registry.ts` 的 `ordinal` 为准（严禁用页面序号；当前可见步骤以 `GET /api/workflows/:id?view=status` 或 CLI `step list` 动态返回为准）：

| ordinal / 插座 | key | 核心输入 → 产物 | 关键就绪、封存态与阻断规则 |
| --- | --- | --- | --- |
| `1` (内含`2`) | `receive_materials` | 旧目录清单 → 入库与 PDF 提取 | 仅旧流程使用；PDF 内部提取 `ordinal=2` 须一并确认终态 |
| `9` | `redact_materials` | 旧流程入库正文 → 脱敏正文 | 仅旧流程使用；`library_v1` 走材料库 `redact` 任务 |
| `4` | `author_question` | 冻结来源附件 + 项目 Skill + 同版有效建议 → 题包 | 若存在 `inline_before_gate` 定制关卡会在入队前 0 槽位校验；若返回 `content_status=draft`，区分“材料不足以支撑核心任务（停止报告）”与“任务内待核事项” |
| 定制步骤插座 | `custom-steps` | 当前步骤4题包 + 附件 → 隔离沙盒校验/标定记录 | 仅已注册主项目生效（如 ALE `ale_verify_gate`、`ale_calibrate_runs`），未注册项目 0 查询短路；若声明 `blocks_downstream_ordinal=8`，未在当前题包摘要下 `succeeded` 前阻断第8步归档 |
| `5` / `6` / `7` | `model_answer` / `independent_score` / `accept_or_revise` | 题面 → 逐模型作答 → 独立评分 → `accepted`/`repair` | **受 `SEALED_STEP_ORDINALS` 动态控制**：封存开启（`isEvaluationPipelineSealed()=true`，当前默认封存 `[5,6,7]`）时步骤隐藏且拒绝派发，出题（及必过定制步骤）完成后直接进入第8步（`author_only_sealed`）或飞书/打包交付；未封存时按 `4→5→6→7→8` 推进，`repair` 须先生成同版有效手动返修建议才可重跑 |
| `8` | `publish_export` | 当前可交付题包 → 本地归档与项目 `delivery.ts` 产物 | 单题归档可带外部身份 `POST /workflows/:id/publish`（CLI：`workflow publish --task-id ... --org ...`）；与项目 Excel 导出（`POST /projects/:id/export`）独立 |

- **项目定制步骤操作（`custom_step_runs`）**：先读 `GET /api/workflows/:id/custom-steps`（CLI：`custom-step list --workflow <ID>`）确认 `available`、`steps[].ready` 与 `active_sub_runs`；触发 `POST .../custom-steps/:stepKey/run`（CLI：`custom-step run`，可选 `--file JSON` 传 `preset` / `max_parallel_subruns`）；有界等待用 CLI `custom-step wait`；取消在途用 `POST .../cancel`；写入结构化返修评价用 `PUT .../repair-evaluation`（CLI：`custom-step repair-evaluation`，必须为含非空 `action_items` 的 JSON 对象）。`queued_subruns` 每个子运行独立占 1 个 Agent 槽位并按滑动窗口（`<=12`）并发推进。
- **高效滚动调度**：
  1. 固定本轮候选 ID（存 `.storage/` 运行记录，不替代服务端状态）→ 每轮并发读 `/api/monitor`、`/api/system/execution-queue` 与本批 `workflow-status`。
  2. 同批**逐题推进**（不等整批齐步）：将当前 `ready` 且在授权终点内的题目合并调用 `POST /api/projects/:id/steps/:ordinal/run-batch`（每请求单一步骤）。`429 local_queue_full` 表示未派发，按空槽补位，不盲目重试。
  3. 无可派发项且有活动任务时，用 `wait_ms<=30000&view=status` 短等后刷新整组；超时或心跳停滞用 `bun scripts/diagnostics/read-logs.ts --attempt-id <ID>` 排查，不凭 `running` 宣称远端仍在生成。到达授权终点立即停止。

## 6. 五大主项目交付矩阵与显式恢复

### 主项目交付差异矩阵（详见 [发布模块](../server/publishing/README.md) 与 [CLI飞书说明](../cli/README.md#豆包飞书交付)）

| 主项目 | 核心交付物与附件规则 | API / CLI 交付入口与验收凭据 |
| --- | --- | --- |
| 豆包法律 / 豆包改题 | 多维表格记录 + **合册**参考资料（`combined_material:true`，显式指定 `pdf` 或 `docx`，超 15MB 自动按连续页无损分册并缓存） | 草稿 `POST /workflows/:id/feishu-draft-sync`，归档后 `/feishu-sync`（CLI 单题或 `feishu [draft-]sync-batch --concurrency 4`）；共用 `deliverQuestionToFeishu()`；**必须核对本次 `status=succeeded` 且 `verification.status=passed`** |
| 豆包医疗 | 多维表格记录 + **逐份独立脱敏 DOCX**（不合册，默认拒绝 `pdf` 与 `combined_material`） | 同上飞书草稿/归档同步入口（不传 `--combined-material`）；核对目标表回执 `verification.status=passed` |
| Work法律全场景 | 严格一包一题；Siriser 标准五件套 ZIP（校验五件套 SHA256 与外部 `task_id`/`org`） | 先完成第8步归档，再 `GET /workflows/:id/siriser-zip`（CLI：`siriser download`，仅下载本地包，网页上传另走浏览器并回读平台状态） |
| Skill Dependency | 无需飞书同步；出题（步骤4）完成后直接在线组装标准目录 ZIP（`task_prompt.md` + `reference/` + `gt/` + `rubrics/` + `skills/`，响应头带 `X-Content-SHA256`） | `GET /api/workflows/:id/skill-dependency-package`（CLI：`skill-dependency download --workflow <ID> --out <新路径.zip>`） |
| ALE | 出题前过 `ale_pre_authoring_lock`；出题后依次通过 `ale_verify_gate` 与 `ale_calibrate_runs`（阻断第8步）→ 产出标准任务目录包（含可执行 `grade.py`） | 先跑通 `custom-steps` 至 `succeeded`，再执行第8步 `publish_export` 触发 `projects/ALE/scripts/delivery.ts` |

- **批量飞书交付对账**：交付前后用 `GET /workflows/:id?view=status` 或 CLI `workflow delivery show --project <期次UUID> (--ids ... | --all) [--base-token <BASE> --table <TABLE>]` 并发汇总全期归档与目标表核验状态，直接读取 `pending_sync_workflow_ids` 定位漏传或核验未通过题目。新表交付先建 1 张表再写入，交付前分页查清互补表防重。
- **未达标/复核导出**：仅在用户要求 CLI 时运行 `export failed` 或 `export review --ids`，固定输出至 `assets/未达标题目/`，不改数据库状态。

### 显式恢复入口（先核实原对象状态，不自动重放；详见 [CLI恢复说明](../cli/README.md#显式恢复与交付确认)）
- **出题检查点恢复 / 历史成功尝试切换**：恢复中断检查点用 `POST /workflows/:id/authoring-results/:attemptId/restore`（CLI：`workflow authoring restore`）；切换同题历史成功出题用 `/authoring-results/:attemptId/select`（CLI：`workflow authoring select --expected-latest-attempt <UUID>`）。
- **历史作答与评分关联恢复**：步骤清空后重绑当前有效历史成果用 `POST /workflows/:id/answer-score-results/restore`（CLI：`workflow answer-score restore [--answer-only]`）。
- **Agent 脱敏程序复核**：`POST /api/material-library/redactions/:id/revalidate`（CLI：`library redaction revalidate`，须同时核对 `valid` 与 `usable_for_question`）。
- **钩子补执行/续跑**：先读 `GET /workflows/:id/hooks`；后置增强用 `POST /api/hooks/:id/retry`，旧失败主尝试用 `POST /api/attempts/:id/resume-hooks`（非幂等须确认后传 `acknowledge_side_effects:true`）。
- **归档撤回 / 题设修订 / 软删对账与恢复**：`POST /workflows/:id/withdraw-archive`、`PATCH /workflows/:id/authoring-direction`、`POST /workflows/:id/opening-revisions`；查已软删题来源用 `GET /projects/:id/deleted-question-sources?ids=...`（CLI：`workflow deleted-sources`），按精确数量恢复用 `POST /projects/:id/workflows/restore-soft-deleted`。
- **跨机未消费评分 / 停机尝试取消与本机队列对账**：取消未开始评分 `POST /api/attempts/:id/cancel-waiting-score`（CLI：`attempt cancel-waiting-score`）；用户确认原执行机已停机后取消陈旧作答/评分 `POST /api/attempts/:id/cancel-stopped-executor`（CLI：`attempt cancel-stopped-executor`）；本机队列认领/放弃/失败结算用 `queue adopt | abandon-job | abandon-import | reconcile-failed`。
