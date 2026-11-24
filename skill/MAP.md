# Workflow Skill 地图

路径均相对于仓库根目录。默认调用本机 `http://127.0.0.1:3700` HTTP API；用户明确要求命令行时使用 CLI（`bun run ai-distill [<前缀>] --help`）。严禁直连数据库。

## 1. 核心目录地图

```text
ai-distill/
├── skill/                         # 工作流操作 Skill（.agents/skills/ai-distill-workflow 软链接至此）
├── toolSkills/                    # 专项工具 Skill（满载补位、飞书通用CLI、AI痕迹审查、豆包复测、出题模拟）
├── cli/                           # HTTP API 命令行客户端 + 共用底座(shared.ts) + 本地批次/复核导出/离线作业台
├── shared/step-registry.ts        # 唯一稳定步骤身份来源（ordinal ↔ key）及 SEALED_STEP_ORDINALS 封存开关
├── server/app.ts                  # Hono HTTP 路由总装配
├── server/execution-queue/        # 本机 SQLite 队列（agent/api/web/internal）、容量与故障对账
├── server/custom-steps/           # 项目级隔离定制步骤插座（custom_step_runs、前后置关卡与多路子运行）
├── server/lifecycle/              # 主项目注册解析、工作流后置钩子与标准流程基线
├── server/material-library/       # 全局材料库：原子入库、提取、Agent/API化名、整理、预览与期次加载
├── server/authoring|answer-models|scoring|decisions|publishing|reporting/ # 核心步骤与交付导出
├── server/web-agent|web-executors/# 浏览器通道驱动与网页对话内校验执行器
└── projects/<项目>/               # 各主项目规则资料、skill（仅作者读取）、custom-steps 与交付脚本
```

## 2. 稳定步骤与模块映射

| 稳定 key / 插座 | ordinal | 服务端核心模块 | 说明 |
| --- | --- | --- | --- |
| `receive_materials` | `1` (内含`2`) | `server/intake-jobs.ts`、`server/materials/jobs.ts` | 旧目录/旧材料包入库与 PDF 提取（`library_v1` 改走材料库导入） |
| `redact_materials` | `9` | `server/materials/redaction-jobs.ts` | 旧流程脱敏（`library_v1` 改走材料库 `redact` 任务） |
| `author_question` | `4` | `server/authoring/jobs.ts`、`executor.ts` | 隔离出题（支持 `codex`/`agy`/`web`/`offline` 及前置 `inline_before_gate`） |
| `custom-steps` | 锚定 `1/4/8/9` | `server/custom-steps/jobs.ts`、`routes.ts`、`projects/*/custom-steps/` | 隔离定制步骤插座（如 ALE `ale_verify_gate`、`ale_calibrate_runs`），可配置 `blocks_downstream_ordinal=8` |
| `model_answer` | `5` | `server/answer-models/jobs.ts`、`dispatch.ts` | 按期次冻结模型集合并发作答（受 `SEALED_STEP_ORDINALS` 控制，默认封存隐藏） |
| `independent_score` | `6` | `server/scoring/jobs.ts`、`executor.ts`、`validate.ts` | 隔离评分（支持 Agent 或独立 API；受 `SEALED_STEP_ORDINALS` 控制） |
| `accept_or_revise` | `7` | `server/decisions/jobs.ts`、`acceptance.ts` | 达标判定 `accepted`/`repair`/`quarantine`（封存开启时第8步走 `author_only_sealed`） |
| `publish_export` | `8` | `server/publishing/tasks.ts`、`jobs.ts`、`project-delivery.ts` | 本地归档与项目 `scripts/delivery.ts`；Excel 另走 `server/reporting/export.ts` |

## 3. 服务端 HTTP API 导航

| 领域 | 主要 HTTP 路由 | 关键契约与分页/轻量参数 |
| --- | --- | --- |
| 系统、并发与队列 | `GET /api/health`、`/api/monitor-sources`、`/api/monitor[?source=]`、`GET/PUT /api/system/concurrency-settings`、`GET/PUT /api/system/step-prompts`、`GET/PUT /api/agent/config`、`POST /api/agent/test`、`GET /api/system/execution-queue[?include_history=true]`、`POST /execution-queue/adopt`、`/:id/cancel`、`/:id/abandon-library-job`、`/:id/abandon-library-import`、`/:id/reconcile-failed` | 队列默认仅返回活动与待核实项；并发修改若返回 `restart_required=true` 需授权重启 |
| 主项目与期次管理 | `GET/POST /api/projects`、`POST /api/projects/creation-receipt`、`GET/PATCH/DELETE /api/projects/:id[?workflow_page=&workflow_page_size=]`、`GET /projects/:id/preview`、`GET/PATCH/DELETE /api/project-groups...`、`PATCH /projects/:id/phase-identity` | 项目详情带 `workflow_page` 时内层先分页后投影（单页<=500） |
| 期次设置、模型、规则与 Skill | `GET/PUT/DELETE /projects/:id/agent-settings`、`GET /api/llm-api/models`、`GET/POST /api/answer-models`、`PUT /api/answer-models/:id`、`GET/PUT /projects/:id/answer-models`、`/answer-generation-policy`、`/answer-tools`、`PUT/DELETE /steps/:ordinal/config`、`PUT /steps/:ordinal/prompt`、`GET/PUT/POST/DELETE /projects/:id/rules[/file]`、`POST /skill/generate`、`GET /skill/attempts`、`POST /skill/attempts/:attemptId/adopt` | `/api/llm-api/models` 查 API 脱敏/整理/评分可用模型；`/api/answer-models` 管理系统模型目录 |
| 全局材料库 | `POST/GET /api/material-library/imports[?page=&page_size=]`、`GET /packages[?page=&page_size=&q=&redaction_state=&preparation_state=]`、`GET/PATCH/DELETE /packages/:id`、`GET/POST /packages/:id/revisions[?page=&page_size=]`、`POST /revisions/:id/jobs`、`GET /jobs/:id`、`POST /jobs/:id/cancel`、`POST /revisions/:id/prepare`、`POST /jobs/:id/prepare-resume`、`GET /packages/:id/preparations[?page=&page_size=&summary_only=true]`、`GET /preparations/:id[?include_content=true]`、`GET /revisions/:id/documents`、`GET /redactions/:id/preview[?file_id=&metadata_only=true]`、`POST /redactions/:id/revalidate` | 新包统一走 `POST /imports` 原子提取入库；`redact` 与 `prepare` 均支持 `agent_settings`/`api_settings`；判存整理加 `summary_only=true` |
| 期次材料加载与建题 | `GET /projects/:id/material-processing`、`/loaded-materials/summary?processing_mode=`、`/material-candidates`、`GET/POST/PATCH/DELETE /loaded-materials[?page=&page_size=]`、`POST /loaded-materials/:linkId/questions`、`GET/PATCH /material-uses[?page=&page_size=]`、`GET /material-uses/:useId/events[?page=&page_size=]`、`/legacy-materials` | 修改关系与使用台账带 `If-Match` 版本锁 |
| 题目、定制步骤与恢复 | `GET /projects/:id/workflow-ids?kind=&page=&page_size=`、`/questions?page=&limit=`（或 `?ids=`）、`/workflow-status?ids=`、`GET /workflows/:id[?view=status]`、`/library-history`、`GET/POST /workflows/:id/custom-steps[/:stepKey/run|/cancel]`、`PUT .../custom-steps/:stepKey/repair-evaluation`、`POST /projects/:id/steps/:ordinal/run-batch`、`POST /workflows/:id/publish`、`GET /attempts/:id[?wait_ms=&view=status]`、`POST /attempts/:id/cancel-waiting-score`、`/cancel-stopped-executor`、`GET/POST /workflows/:id/revision-advice`、`POST /workflows/:id/material-scope`、`PATCH /authoring-direction`、`POST /opening-revisions`、`/authoring-results/:attemptId/restore|/select`、`/answer-score-results/restore`、`/withdraw-archive`、`GET /hooks`、`POST /hooks/:id/retry`、`/attempts/:id/resume-hooks`、`GET /projects/:id/deleted-question-sources`、`POST /projects/:id/workflows/restore-soft-deleted` | 列表/轮询优先用 `workflow-ids`、`questions`、`workflow-status` 与 `?view=status` |
| 成果、导出与交付包 | `GET /api/results[?page=&page_size=&q=&publication=]`、`GET/POST /projects/:id/exports`、`/export`、`GET /exports/:id/download`、`/artifacts/:id/download`、`/materials/:id/download`、`POST /workflows/:id/material-docx`、`/redacted-docx`、`GET /material-image-docx`、`/archive-xlsx`、`/siriser-zip`、`/skill-dependency-package`、`GET/PUT /projects/:id/feishu-delivery`、`POST /feishu-tables`、`/workflows/:id/feishu-draft-sync`、`/feishu-sync` | 飞书交付须核对回执 `status=succeeded` 且 `verification.status=passed` |

## CLI 工具地图

所有命令支持 `--json` 与按前缀查帮助（如 `bun run ai-distill custom-step --help`）。参数规范见 [cli/README.md](../cli/README.md) 与 `cli/commands.ts`。

| 能力组 | CLI 命令 | 实现文件 | 说明 |
| --- | --- | --- | --- |
| 项目、提示词、规则与 Skill | `project list/show/create/update/phase-update/delete/sync`、`project-group ...`、`project settings show/apply`、`project prompt update`、`rules list/file/update/delete`、`project skill list/generate/adopt` | `commands.ts`、`shared.ts` | `show` 支持 `--workflow-page/--workflow-page-size`；`prompt update` 同步主项目步骤 4/5/6 提示词 |
| 全局材料库 | `library files prepare`、`library import`、`library imports list`、`library package list/show/usage/revisions/update/archive/restore`、`library revision create`、`library job start/show/wait/cancel`、`library prepare start/resume/diagnose/list/show`、`library batch plan/run`、`library documents show/export/import`、`library redaction show/revalidate`、`library file download`、`library template/processing ...` | `commands.ts`、`library-batch.ts`、`material-export.ts`、`shared.ts` | `job start`（`redact`）与 `prepare start` 支持 `--api-provider --api-model` / `--api-settings-file`；`documents export` 4 并发拉取 |
| 期次材料与旧包 | `project material candidates`、`project materials mode/summary/onboard/list/load/update/remove/restore/question`、`project material uses`、`project material use events/update`、`project legacy-materials ...`、`material-package list/versions`、`project material-mode` | `commands.ts`、`project-onboard.ts`、`shared.ts` | `mode/summary` 速查期次处理模式与可用数；`onboard` 一步自动选版加载并幂等建题 |
| 工作流、定制步骤与恢复 | `question list/show/create/delete`、`workflow status/attempts/delivery show/design update/opening revise/material-scope sync/authoring restore/authoring select/answer-score restore/publish/archive withdraw/library-history/deleted-sources/restore-deleted/hooks show`、`custom-step list/run/wait/cancel/repair-evaluation`、`hook retry`、`attempt show/wait/resume-hooks/cancel-waiting-score/cancel-stopped-executor`、`step list/dispatch`、`advice show/generate`、`batch create/show/skip`、`material text --redacted-only`、`material download`、`models catalog/api-catalog/show/register/toggle` | `commands.ts`、`batches.ts`、`shared.ts` | `workflow delivery show` 支持 `--project (--ids\|--all)` 并发汇总漏传清单；`custom-step` 覆盖项目定制步骤全生命周期 |
| 系统、队列、网页与离线 | `system health`、`system concurrency show/update`、`system prompts show/update`、`monitor sources`、`monitor show [--source]`、`queue show[--history]/diagnose/cancel/adopt/abandon-job/abandon-import/reconcile-failed`、`agent config show/update`、`agent test`、`web status/doctor/login/close`、`offline export/import/status`、`remote material/answer ...` | `commands.ts`、`queue-diagnostics.ts`、`offline.ts`、`remote-*.ts`、`shared.ts` | `offline export` 分页早停并 4 并发拉取；覆盖多实例监控、队列对账、浏览器通道与离线作业台 |
| 成果、下载与飞书 | `result list/show`、`export list/create/download/failed/review`、`artifact download`、`siriser download`、`skill-dependency download`、`workflow material-docx generate`、`workflow redacted-docx generate`、`workflow material-image-docx download`、`workflow archive-xlsx download`、`feishu config/table/draft-sync/draft-sync-batch/sync/sync-batch/local-sync` | `commands.ts`、`feishu*.ts`、`failed-export.ts`、`server/publishing/feishu-delivery.ts` | 共用 `deliverQuestionToFeishu` 与 `hasFeishuAttachmentNames`；`draft-sync-batch`/`sync-batch` 默认 4 并发（`--concurrency N`） |

## 4. 代码修改定位

| 修改目标 | 首查位置 | 同步核对 |
| --- | --- | --- |
| 调度/恢复/停止决策规则 | `skill/SKILL.md` | `skill/MAP.md`、`cli/README.md` |
| HTTP 路由与分页/投影契约 | `server/app.ts`、`server/workflow-execution-routes.ts` 及子模块路由 | `web/`、`cli/commands.ts`、模块 `README.md` 与单测 |
| 项目隔离定制步骤扩展 | `server/custom-steps/`、`projects/<项目>/custom-steps/` | `cli/commands.ts`、`web/src/components/WorkflowCustomSteps.vue` |
| 本机 CLI 命令与旗标白名单 | `cli/commands.ts`（`HELP` + `COMMAND_FLAGS` + `switch`）、`cli/shared.ts` | `cli/commands.test.ts`、`cli/README.md`、本文 |
| 步骤就绪、封存态或达标判定 | `shared/step-registry.ts`、`server/project-folders.ts`、`server/decisions/` | `server/rule-currentness.test.ts`、前后端测试 |
