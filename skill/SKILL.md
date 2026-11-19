---
name: ai-distill-workflow
description: Use when the user asks to inspect, execute, or improve ai-distill workflow throughput, worker/API scheduling, long waits, batch processing, authoring, answering, scoring, acceptance, archiving, Feishu delivery, or Siriser five-piece preparation. Use browser-skill for actual external webpage operations.
---

# ai-distill 工作流操作规则

## 1. 入口与硬边界

- **决策优先级**：`用户当前要求 > 本次任务约定 > 项目配置与项目 Skill > 本文件默认流程`。
- **调用入口**：本机工作流默认直接调用 `http://127.0.0.1:3700` HTTP API；用户明确要求命令行时使用 CLI（按前缀查精确旗标：`bun run ai-distill <前缀> --help`，如 `library --help`、`feishu --help`；详情见 [CLI 指南](../cli/README.md)）。
- **禁令**：严禁直连 PostgreSQL 或 SQLite 读写业务数据；未获明确授权不重启服务、不跑迁移、不改模型/阈值/提示词/规则文件、不删除项目或题目。写请求超时或断连**绝不换键盲重发**，先按原 ID / `request-key` 核实状态。
- **职责分离**：本目录规定工作流调度；`projects/<项目>/skill/` 规定项目出题内容（仅出题作者读取，不注入被测作答或独立评分）。定位代码与路由读 [MAP.md](MAP.md)，分层边界读 [ARCHITECTURE.md](ARCHITECTURE.md)，远程隧道读 [REMOTE.md](REMOTE.md)。

## 2. 执行通道选择

| 通道 | 适用阶段与场景 | 容量与调用方式 |
| --- | --- | --- |
| `agent` | 本地 Codex/AGY 执行 `redact`（`aliases`）、`prepare`、步骤4出题、步骤6 Agent评分、手动返修建议、项目Skill生成 | 读 `/api/system/concurrency-settings` 与 `/api/system/execution-queue` `capacity.agent`；单次出题可传 `authoring_settings:{provider,model,reasoning_effort}` |
| `api` | PDF/DOCX 提取、步骤5模型作答、步骤6 API评分、API脱敏/整理 | 读 `capacity.api`；与 `agent` 独立消费池，槽位不可互转 |
| `web` | 经已登录浏览器自动跑 `prepare`（deepseek）或步骤4出题（deepseek/gemini） | 独立 6 槽位 `capacity.web`（需 064 迁移）；HTTP 传 `web_settings`，CLI 用 `--web` 及 `web status/doctor/login/close`；不支持自动 `redact` |
| `offline` | 人工网页交互作业台（`redact` / `prepare` / `author` 导出每任务 zip + 对账台，贴回 `reply/reply-N.md` 校验入库） | 仅 CLI 本地工具 `offline export/import/status`（需用户指定命令行且共用 `STORAGE_DIR`） |
| `remote` | SSH 隧道交服务器跑**旧工作流**入库/`declared_redacted` 兼容处理或**无钩子题目**模型作答 | 仅用户要求命令行且满足 [REMOTE.md](REMOTE.md) 前置时用 `remote material|answer`；不跑全局库本地 blob、出题、评分或归档 |

> 仅限 CLI 的本地文件工具（无对应 HTTP 导出路由）：`export failed`、`export review`、`offline`、`feishu local-sync`、`library documents export`。未获命令行要求时说明接口边界，不暗自切 CLI。

## 3. 材料库与期次不变量

1. **上传前检查与预处理**：上传或派发提取前检查单文件大小与 `pdfinfo` 页数（核对 `server/validation.ts` 与 OCR 限制）。DOC/WPS/OFD 转换及超限 PDF 切割复用 `prepareLibraryFiles()`（CLI：`library files prepare`，见 [预处理说明](../cli/README.md#ofd与超限pdf上传前准备)），生成新清单后再入库；全局材料库上传**不自动切割**，禁止用旧 `sync-folder` 替代。
2. **原子提取入库**：新材料经 `POST /api/material-library/imports`（CLI：`library import`）提交，全部提取通过才发布正式 `package_id`/`revision_id`（旧 `POST /packages` 已停用返回 410）；已有包新版本用 `POST /packages/:id/revisions`。
3. **处理模式与来源冻结**：先读 `GET /api/projects/:id/material-processing`（`aliases` 默认 Agent 整包化名，`original` 使用成功提取原文，`mask` 仅历史只读）。项目材料任务必传 `project_id`。建题快照永久冻结来源与可见文书，后续改期次设置不影响旧题。主项目 `project_material_uses` 跨期防重；退回 `in_use` 仅用于原期返修，不释放跨期占用。
4. **单包题量规则**：由具体项目规则决定。**Work法律全场景固定一包一题**（出题前必读 [Work规则](../projects/Work法律全场景/AGENTS.md) 与 [Work Skill](../projects/Work法律全场景/skill/SKILL.md)）；不推广至其他主项目。
5. **可选材料整理（`prepare`）**：基于成功脱敏或提取生成总摘要、逐份可见性与候选组合（[CLI整理说明](../cli/README.md#材料整理)）。重跑传 `force:true` + 新 `request_key`；单次默认预算 30 分钟，到期停止不自动重试；缺失或失败不阻断建题。CLI 自然语言批量筛选派发用 `library batch plan/run`（多条件为 **AND** 关系）。

## 4. 分页与轻量读取契约（严禁全表拉取充当目录）

| 场景 | 推荐轻量接口 / 参数 | 默认与上限 / 翻页依据 |
| --- | --- | --- |
| 取全期工作流 ID（如 `--all`） | `GET /api/projects/:id/workflow-ids?kind=question&page=1&page_size=500` | 最大 1000/页，按 `has_more` 翻页 |
| 最近 N 题或指定 ID 交付预检 | `GET /api/projects/:id/questions?page=1&limit=100` 或 `?ids=UUID,...` | `limit` 1–1000（按创建时间倒序，非完成时间）；`ids` 最多 1000 |
| 项目详情工作流分页 | `GET /api/projects/:id?workflow_page=1&workflow_page_size=100` | 单页最大 500，看 `workflow_has_more`；步骤4全期未出题就绪数看 `steps[].unauthored_ready` |
| 单题/批量步骤状态与归档回执 | `GET /api/workflows/:id?view=status`（CLI：`question show --status`）；批量 `GET /api/projects/:id/workflow-status?ids=...` | `workflow-status` 每批 <=100；**注意工作流详情仅 `?view=status` 省略大字段**（需要题面/答案全文才不传 `view`） |
| 轮询 attempt 状态 | `GET /api/attempts/:id?wait_ms=30000&view=status`（CLI `attempt wait` 默认轻量） | 单次 `wait_ms` <=30s；看正文用 `attempt show` 或 `wait --full` |
| 材料库包/导入/版本/整理列表 | `/packages?page=1&page_size=50`（看 `total_count`）；`/imports`、`/revisions`、`/loaded-materials`、`/material-uses`、`/events` 均支持 `page` & `page_size` | 仅判断是否有整理成果必加 `preparations?summary_only=true&page_size=1`（CLI `--summary-only`）；脱敏仅看校验报告用 `redactions/:id/preview?metadata_only=true`（CLI `--metadata-only`） |
| 成果列表与导出历史 | `GET /api/results?page=1&page_size=100&q=&publication=all|archived|pending`；`/exports?page=1&page_size=100` | 单页最大 500，看 `has_more` |
| 本机执行队列 | `GET /api/system/execution-queue`（CLI：`queue show`） | 默认仅返回活动与待核实项；查终态历史加 `?include_history=true`（CLI `--history`） |

## 5. 步骤派发、滚动调度与等待

稳定步骤身份以 `shared/step-registry.ts` 的 `ordinal` 为准（严禁用页面序号）：

| ordinal | key | 核心输入 → 产物 | 关键就绪与阻断规则 |
| --- | --- | --- | --- |
| `1` (内含`2`) | `receive_materials` | 旧目录清单 → 入库与 PDF 提取 | 仅旧流程使用；PDF 内部提取 `ordinal=2` 须一并确认终态 |
| `9` | `redact_materials` | 旧流程入库正文 → 脱敏正文 | 仅旧流程使用；`library_v1` 走材料库 `redact` 任务 |
| `4` | `author_question` | 冻结来源附件 + 项目 Skill + 同版有效建议 → 题包 | 若 `content_status=draft`，区分“材料不足以支撑核心任务（停止报告）”与“任务内待核事项”；已 `accepted` 题批量跳过 |
| `5` | `model_answer` | 题面 + 允许附件 → 逐模型答案 | 须配置作答模型集合与阈值；多模型返回多个 `attempt_ids`，**必须全部跟踪** |
| `6` | `independent_score` | 同版题面 + rubric + 附件 + 匿名答案 → 评分 | 默认不传标答（仅显式 `calibration` 契约传标答参考） |
| `7` | `accept_or_revise` | 有效评分 + 模型阈值/聚合规则 → `accepted` / `repair` | 评分全部完成后通常自动生成；若为 `repair`，步骤 4–6 须先生成有效手动返修建议（`POST /workflows/:id/revision-advice`）才重新就绪 |
| `8` | `publish_export` | 当前 `accepted` 题 → 本地归档产物 | 与项目 Excel 导出（`POST /projects/:id/export`）相互独立 |

**高效滚动调度**：
1. 固定本轮候选 ID（保存在 `.storage/` 运行记录，不替代服务端状态）→ 每轮并发读 `GET /api/monitor`、`/api/system/execution-queue` 与本批 `workflow-status`。
2. 同批**逐题推进**（不等整批齐步）：将当前 `ready` 且在授权终点内的题目按步骤合并调用 `POST /api/projects/:id/steps/:ordinal/run-batch`（每请求单一步骤）。`429 local_queue_full` 表示未派发，按空槽补位，不盲目重试。
3. 无可派发项且有活动任务时，用 `wait_ms<=30000&view=status` 短等后刷新整组；超过预期时限或心跳停滞时用 `bun scripts/diagnostics/read-logs.ts --attempt-id <ID>` 排查，不凭 `running` 宣称远端仍在生成。到达授权终点立即停止。

## 6. 交付、导出与显式恢复

### 豆包飞书交付（详见 [发布模块](../server/publishing/README.md#豆包飞书交付) 与 [CLI飞书说明](../cli/README.md#豆包飞书交付)）
- **模式选择**：出题成功未归档走 `POST /workflows/:id/feishu-draft-sync`（表内标“未完成”）；已达标归档走 `POST /workflows/:id/feishu-sync`。合册传 `attachment_format:"pdf"|"docx", combined_material:true`（超 18MB 自动按连续页无损分册）；精确替换旧记录传 `replace_record_id`（CLI：`--replace-record-id`）。脱离业务 API 的本地快照草稿仅在用户明确要求时用 CLI `feishu local-sync`。
- **防重与验收**：交付前分页查清全部互补表 UUID 防重；新表交付先建 1 张表再串行写入；**仅本次返回 `status=succeeded` 且 `verification.status=passed` 才计交付成功**（本地第8步归档成功 ≠ 飞书同步成功，查回执用 `GET /workflows/:id?view=status` 或 CLI `workflow delivery show`）。

### Work Siriser 五件套与未达标复核包
- **Siriser**：先批量预检 `accepted` + 第8步归档成功 + ZIP 五件套哈希与外部任务身份齐全，再逐题页面上传提交并回读平台状态；CLI `siriser download` 仅下载本地 ZIP，不执行平台提交。
- **未达标/复核导出**：仅在用户要求 CLI 时运行 `export failed`（当前 `repair` 题）或 `export review --ids`（指定已评分题），固定输出至 `assets/未达标题目/`，不改数据库状态。

### 显式恢复入口（先核实原对象状态，不自动重放；详见 [CLI恢复说明](../cli/README.md#显式恢复与交付确认)）
- **出题检查点恢复**：`POST /api/workflows/:id/authoring-results/:attemptId/restore`（CLI：`workflow authoring restore`）
- **Agent 脱敏程序复核**：`POST /api/material-library/redactions/:id/revalidate`（CLI：`library redaction revalidate`，须同时核对 `valid` 与 `usable_for_question`）
- **钩子补执行/续跑**：先读 `GET /workflows/:id/hooks`；后置增强用 `POST /api/hooks/:id/retry`，旧失败主尝试用 `POST /api/attempts/:id/resume-hooks`（非幂等须确认后显式 `acknowledge_side_effects:true`）
- **归档撤回 / 题设修订 / 软删恢复**：`POST /workflows/:id/withdraw-archive`、`PATCH /workflows/:id/authoring-direction`、`POST /workflows/:id/opening-revisions`、`POST /projects/:id/workflows/restore-soft-deleted`
- **本机队列异常对账**：旧任务认领 `POST /api/system/execution-queue/adopt`；放弃过租无活动执行器的材料任务 `POST /api/system/execution-queue/:id/abandon-library-job`（原子入库专用兼容 `/abandon-library-import`）；凭明确失败日志结算 `needs_review` 步骤 `POST /api/system/execution-queue/:id/reconcile-failed`（CLI：`queue adopt / abandon-job / abandon-import / reconcile-failed`）。
