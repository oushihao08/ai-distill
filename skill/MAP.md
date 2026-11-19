# Workflow Skill 地图

路径均相对于仓库根目录。默认调用本机 `http://127.0.0.1:3700` HTTP API；用户明确要求命令行时使用 CLI（`bun run ai-distill [<前缀>] --help`）。严禁直连数据库。

## 1. 核心目录地图

```text
ai-distill/
├── skill/                         # 工作流操作 Skill（.agents/skills/ai-distill-workflow 软链接至此）
├── toolSkills/                    # 专项工具 Skill（满载补位、飞书通用CLI、AI痕迹审查）
├── cli/                           # HTTP API 命令行客户端 + 本地批次/复核导出/离线作业台
├── shared/step-registry.ts        # 唯一稳定步骤身份来源（ordinal ↔ key）
├── server/app.ts                  # Hono HTTP 路由总装配
├── server/execution-queue/        # 本机 SQLite 队列（agent/api/web/internal）、容量与故障对账
├── server/material-library/       # 全局材料库：原子入库、提取、Agent化名、整理、预览与期次加载
├── server/authoring|answer-models|scoring|decisions|publishing|reporting/ # 核心步骤与交付导出
├── server/web-agent|web-executors/# 浏览器通道驱动与网页对话内校验执行器
└── projects/<项目>/skill/         # 各项目出题业务规范（仅作者读取）
```

## 2. 稳定步骤与模块映射

| 稳定 key | ordinal | 服务端核心模块 | 说明 |
| --- | --- | --- | --- |
| `receive_materials` | `1` (内含`2`) | `server/intake-jobs.ts`、`server/materials/jobs.ts` | 旧目录/旧材料包入库与 PDF 提取（`library_v1` 改走材料库导入） |
| `redact_materials` | `9` | `server/materials/redaction-jobs.ts` | 旧流程脱敏（`library_v1` 改走材料库 `redact` 任务） |
| `author_question` | `4` | `server/authoring/jobs.ts`、`executor.ts` | 隔离出题（支持 `codex`/`agy`/`web`/`offline`） |
| `model_answer` | `5` | `server/answer-models/jobs.ts`、`dispatch.ts` | 按期次冻结模型集合并发/多尝试作答 |
| `independent_score` | `6` | `server/scoring/jobs.ts`、`executor.ts`、`validate.ts` | 隔离评分（支持 Agent 或独立大模型 API） |
| `accept_or_revise` | `7` | `server/decisions/jobs.ts`、`acceptance.ts` | 达标判定（`accepted` / `repair` / `quarantine`） |
| `publish_export` | `8` | `server/publishing/tasks.ts`、`jobs.ts` | 本地归档与项目交付脚本；Excel 另走 `server/reporting/export.ts` |

## 3. 服务端 HTTP API 导航

| 领域 | 主要 HTTP 路由 | 关键契约与分页/轻量参数 |
| --- | --- | --- |
| 系统、并发与队列 | `GET /api/health`、`/api/monitor`、`GET/PUT /api/system/concurrency-settings`、`GET/PUT /api/agent/config`、`POST /api/agent/test`、`GET /api/system/execution-queue[?include_history=true]`、`POST /execution-queue/adopt`、`/:id/cancel`、`/:id/abandon-library-import`、`/:id/reconcile-failed` | 队列默认仅返回活动与待核实项；并发修改若返回 `restart_required=true` 需授权重启 |
| 主项目与期次管理 | `GET/POST /api/projects`、`GET/PATCH/DELETE /api/projects/:id[?workflow_page=&workflow_page_size=]`、`GET /projects/:id/preview`、`GET/PATCH/DELETE /api/project-groups...`、`PATCH /projects/:id/phase-identity` | 项目详情带 `workflow_page` 时内层先分页后投影（单页<=500） |
| 期次设置、规则与 Skill | `GET/PUT/DELETE /projects/:id/agent-settings`、`GET/PUT /answer-models`、`/answer-generation-policy`、`/answer-tools`、`PUT/DELETE /steps/:ordinal/config`、`GET/PUT/POST/DELETE /projects/:id/rules[/file]`、`POST /skill/generate`、`GET /skill/attempts`、`POST /skill/attempts/:attemptId/adopt` | `GET /api/answer-models` 查系统已登记模型目录 |
| 全局材料库 | `POST/GET /api/material-library/imports[?page=&page_size=]`、`GET /packages[?page=&page_size=&q=&redaction_state=&preparation_state=]`、`GET/PATCH/DELETE /packages/:id`、`GET/POST /packages/:id/revisions[?page=&page_size=]`、`POST /revisions/:id/jobs`、`GET /jobs/:id`、`POST /jobs/:id/cancel`、`POST /revisions/:id/prepare`、`POST /jobs/:id/prepare-resume`、`GET /packages/:id/preparations[?page=&page_size=&summary_only=true]`、`GET /preparations/:id[?include_content=true]`、`GET /revisions/:id/documents`、`GET /redactions/:id/preview[?file_id=&metadata_only=true]`、`POST /redactions/:id/revalidate` | 新包统一走 `POST /imports` 原子提取入库；判存整理加 `summary_only=true`；单文件或仅元数据预览避免拉整包大文本 |
| 期次材料加载与建题 | `GET /projects/:id/material-processing`、`/material-candidates`、`GET/POST/PATCH/DELETE /loaded-materials[?page=&page_size=]`、`POST /loaded-materials/:linkId/questions`、`GET/PATCH /material-uses[?page=&page_size=]`、`GET /material-uses/:useId/events[?page=&page_size=]`、`/legacy-materials` | 修改关系与使用台账带 `If-Match` 版本锁 |
| 题目查询、派发与恢复 | `GET /projects/:id/workflow-ids?kind=&page=&page_size=`、`/questions?page=&limit=`（或 `?ids=`）、`/workflow-status?ids=`、`GET /workflows/:id[?view=status]`、`GET /workflows/:id/steps/:ordinal/attempts?offset=`、`POST /projects/:id/steps/:ordinal/run-batch`、`GET /attempts/:id[?wait_ms=&view=status]`、`GET/POST /workflows/:id/revision-advice`、`PATCH /authoring-direction`、`POST /opening-revisions`、`/authoring-results/:attemptId/restore`、`/withdraw-archive`、`GET /hooks`、`POST /hooks/:id/retry`、`/attempts/:id/resume-hooks`、`/projects/:id/workflows/restore-soft-deleted` | 列表/轮询优先用 `workflow-ids`、`questions`、`workflow-status` 与 `?view=status` |
| 成果、导出与飞书交付 | `GET /api/results[?page=&page_size=&q=&publication=]`、`GET/POST /projects/:id/exports`、`/export`、`GET /exports/:id/download`、`/artifacts/:id/download`、`POST /workflows/:id/material-docx`、`GET /material-image-docx`、`/archive-xlsx`、`/siriser-zip`、`GET/PUT /projects/:id/feishu-delivery`、`POST /feishu-tables`、`/workflows/:id/feishu-draft-sync`、`/feishu-sync` | 飞书交付须核对回执 `status=succeeded` 且 `verification.status=passed` |

## CLI 工具地图

所有命令支持 `--json` 与按前缀查帮助（如 `bun run ai-distill library --help`）。参数规范见 [cli/README.md](../cli/README.md) 与 `cli/commands.ts`。

| 能力组 | CLI 命令 | 实现文件 | 说明 |
| --- | --- | --- | --- |
| 项目、规则与 Skill | `project list/show/create/update/phase-update/delete/sync`、`project-group ...`、`project settings show/apply`、`rules list/file/update/delete`、`project skill list/generate/adopt` | `commands.ts` | `show` 支持 `--workflow-page/--workflow-page-size`；`settings` 含 `codex`/`models`/`steps`/`answer_generation_policy`/`answer_tools` |
| 全局材料库 | `library files prepare`、`library import`、`library imports list`、`library package list/show/usage/revisions/update/archive/restore`、`library revision create`、`library job start/show/wait/cancel`、`library prepare start/resume/diagnose/list/show`、`library batch plan/run`、`library documents show/export/import`、`library redaction show/revalidate`、`library file download`、`library template/processing ...` | `commands.ts`、`library-batch.ts`、`material-export.ts` | `prepare list` 支持 `--summary-only`；`redaction show` 支持 `--metadata-only` |
| 期次材料与旧包 | `project material candidates`、`project materials list/load/update/remove/restore/question`、`project material uses`、`project material use events/update`、`project legacy-materials ...`、`material-package list/versions`、`project material-mode` | `commands.ts` | 全量列表均支持 `--page/--page-size`；写操作带 `--version` |
| 工作流、派发与恢复 | `question list/show/create/delete`、`workflow status/attempts/delivery show/design update/opening revise/authoring restore/archive withdraw/restore-deleted/hooks show`、`hook retry`、`attempt show/wait/resume-hooks`、`step list/dispatch`、`advice show/generate`、`batch create/show/skip`、`material text --redacted-only`、`models catalog/show` | `commands.ts`、`batches.ts` | `question show --status` 走轻量视图；`step dispatch author_question` 支持 `--provider/--model/--reasoning-effort` 或 `--web` |
| 系统、队列、网页与离线 | `monitor show`、`queue show[--history]/diagnose/cancel/adopt/abandon-import/reconcile-failed`、`system concurrency show/update`、`agent config show/update`、`agent test`、`web status/doctor/login/close`、`offline export/import/status`、`remote material/answer ...` | `commands.ts`、`queue-diagnostics.ts`、`offline.ts`、`remote-*.ts` | 覆盖本机队列对账、并发/Agent 探针、浏览器通道与离线 zip 作业台 |
| 成果、下载与飞书 | `result list/show`、`export list/create/download/failed/review`、`artifact download`、`siriser download`、`workflow material-docx generate`、`workflow material-image-docx download`、`workflow archive-xlsx download`、`feishu config/table/draft-sync/draft-sync-batch/sync/sync-batch/local-sync` | `commands.ts`、`feishu*.ts`、`failed-export.ts` | `draft-sync` 支持 `--replace-record-id` 与 `--combined-material`；下载均独占写新文件不覆盖 |

## 4. 代码修改定位

| 修改目标 | 首查位置 | 同步核对 |
| --- | --- | --- |
| 调度/恢复/停止决策规则 | `skill/SKILL.md` | `skill/MAP.md`、`cli/README.md` |
| HTTP 路由与分页/投影契约 | `server/app.ts` 及子模块路由 | `web/`、`cli/commands.ts`、模块 `README.md` 与单测 |
| 本机 CLI 命令与旗标白名单 | `cli/commands.ts`（`HELP` + `COMMAND_FLAGS` + `switch`） | `cli/commands.test.ts`、`cli/README.md`、本文 |
| 步骤就绪或达标判定规则 | `server/project-folders.ts`、`server/decisions/` | `shared/step-registry.ts`、前后端测试 |
