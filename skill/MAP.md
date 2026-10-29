# Workflow Skill 地图

路径均相对于仓库根目录。先读入口；Codex 默认直接调用现有本机 API。只有用户明确要求使用命令行时才运行 CLI；API 与 CLI 都不得直连数据库。命令语法以 `bun run ai-distill --help` 和 [CLI README](../cli/README.md) 为准。

## 文件地图

```text
ai-distill/
├── skill/                         # 操作Skill的真实目录
│   ├── SKILL.md                   # Codex执行规则与步骤卡
│   ├── ARCHITECTURE.md            # 分层、数据流、状态边界与扩展方法
│   ├── MAP.md                     # 本地图：命令、源码与修改位置
│   └── README.md                  # 目录入口及验证边界
├── .agents/skills/
│   └── ai-distill-workflow -> ../../skill
├── cli/
│   ├── index.ts                   # 进程入口、JSON输出、退出码与中断
│   ├── commands.ts                # 项目生命周期/设置、命令映射、范围、分组与等待
│   ├── remote-materials.ts        # 远程入库/脱敏提交、状态恢复、文件清单校验与本机取回
│   ├── remote-answers.ts          # 远程作答提交及按 request-key 恢复状态
│   ├── batches.ts                 # 本机固定范围/批次/跳过清单
│   ├── failed-export.ts           # 当前未达标题包的固定路径与绑定核对
│   ├── client.ts                  # 本机HTTP、JSON错误与下载
│   └── README.md                  # 快速开始、命令参考、状态契约与验证边界
├── shared/step-registry.ts        # 唯一稳定步骤身份来源
├── server/app.ts                  # 现有API装配
├── server/lifecycle/             # 项目策略、生命周期通知和Work/豆包交付注册
├── server/agent/                 # 单次Agent任务和配置公共入口
├── server/llm-api/               # 纯文字/JSON API、供应商配置和用量
├── server/worker.ts               # local/api/materials/server 等持久化任务消费模式
├── server/remote-material-routes.ts # 令牌保护的远程材料及作答 API
└── projects/<项目>/skill/         # 各项目出题规则，非本操作Skill
```

## 共享材料库与期次接口

| 操作 | API／CLI | 对象与结果 |
| --- | --- | --- |
| 建立主项目/期次 | POST `/api/projects` 可带 `project_group_id`、`phase_no`、`phase_name`；CLI `project create`；组导航见 `/api/project-groups` | 每个 `projects.id` 仍是一份隔离期次工作流；主项目身份用于跨期材料使用规则 |
| 管理全局材料包 | `/api/material-library/packages`；CLI `library package ...` | 材料库独立于项目，不因某项目删除而删除 |
| 超限PDF上传前处理 | 本地`prepareLibraryFiles()`；CLI `library files prepare`；见[预处理说明](../cli/README.md#ofd与超限pdf上传前准备) | 复用`server/materials/pdf-split.ts`，生成受管分片、上传清单和来源审计；不改原件、不写数据库；随后通过API上传同包新版本 |
| 建立不可变文件版本并处理 | `POST /packages/:id/revisions`、`POST /revisions/:id/jobs`；CLI `library revision create`、`library job start/show/cancel` | 入库、提取、脱敏是独立任务；使用幂等请求键，不由 CLI 自行处理正文 |
| 加载本期材料 | `/api/projects/:id/material-candidates`、`/loaded-materials`；CLI `project material candidates`、`project materials load/update/remove/restore` | 仅加载全局库包的指定脱敏结果或已提取原文版本；修改关系使用 `If-Match` |
| 建题与永久使用台账 | `POST /loaded-materials/:linkId/questions`、`/material-uses`；CLI `project materials question`、`project material use update` | 创建题目时冻结所选来源；同一主项目不同期不得重复使用材料，返修状态保留事件 |
| 旧材料导入新库 | `/api/projects/:id/legacy-material-imports`；CLI `project legacy-materials list/import/activate` | 先 dry-run 预检；apply需确认来源摘要，激活后建立期次关系 |
| 旧目录/旧材料包 | `/api/projects/:id/sync-folder`、`/api/material-packages/...`、`PATCH /api/projects/:id/material-mode`；CLI `project sync`、`material-package`、`question create`、`project material-mode --clear-existing` | 保留兼容路径；`material-mode` 会软隐藏旧题并使已有导出失效，只用于明确迁移到材料包模式，不等同于全局共享材料库 |

期次身份和导航由 `server/project-groups.ts` 管理；材料 API、存储、任务与处理见 `server/material-library/README.md`。业务契约以对应路由和模块 README 为准；本文只作导航，不复制字段级 API 规范。

## 流程地图

```mermaid
flowchart LR
  I[入库及内部提取] --> R[脱敏]
  R --> Q[出题]
  Q --> A[逐模型作答]
  A --> S[逐答案评分]
  S --> D[系统达标判定]
  D --> P[显式归档]
  D -. 当前达标成果，独立操作 .-> E[项目Excel导出]
```

箭头表示业务依赖，不表示API自动串行执行全部步骤；Codex只执行用户授权范围，达到终点停止。未达标题目由用户决定是否按普通步骤重做。归档与Excel导出是不同操作，导出不以归档为前提。

| 稳定key | ordinal | 主要服务端文件/目录 |
| --- | --- | --- |
| receive_materials | 1 | `server/intake-jobs.ts`、`server/materials/jobs.ts`；PDF提取内部ordinal为2 |
| redact_materials | 9 | `server/materials/redaction-jobs.ts` |
| author_question | 4 | `server/authoring/jobs.ts`、`executor.ts` |
| model_answer | 5 | `server/answer-models/jobs.ts` |
| independent_score | 6 | `server/scoring/jobs.ts`、`executor.ts`、`validate.ts` |
| accept_or_revise | 7 | `server/decisions/jobs.ts`、`acceptance.ts` |
| publish_export | 8 | `server/publishing/tasks.ts`持久派发/消费，`jobs.ts`校验提交；Excel另走`server/reporting/export.ts` |

步骤key与ordinal以`shared/step-registry.ts`为准。隐藏的旧规则绑定/独立审查不作为当前操作入口。

## 服务端 API 导航

默认直接调用服务端本机 API；只有用户明确要求命令行时才使用 CLI。两种入口都必须经过 API，不得直连数据库。请求/响应字段以路由实现为准，下面只列入口类别；CLI 参数见 `cli/README.md`。

| 操作 | API入口 | 用途与影响 |
| --- | --- | --- |
| batch create/show/skip | 创建时GET `/api/projects/:id`；其余仅本地文件 | 固定本轮范围、可配置大小、终点与跳过名单，不派发业务任务 |
| project list/show、question list | GET `/api/projects`、`/api/projects/:id` | 只读定位项目与题目 |
| project create/update/delete | POST/PATCH/DELETE `/api/projects` | 项目CRUD；创建可应用设置文件，删除要求精确确认项目名并沿用服务端逻辑删除/数据清理契约 |
| project settings show/apply | GET/PUT/DELETE 项目 Codex、模型、步骤及作答策略接口 | 读取并应用项目设置；逐项返回结果，部分失败不伪装为原子回滚 |
| models catalog/show | GET `/api/answer-models`、`/api/projects/:id/answer-models` | 查看系统可选模型和项目当前集合，供项目设置使用 |
| question show、result show | GET `/api/workflows/:id` | 当前题包、作答、评分、判定、有限历史和产物 |
| workflow status | GET `/api/projects/:id/workflow-status?ids=…` | 状态、就绪原因与尝试摘要；投影在`server/workflow-view.ts` |
| rules list/file | GET `/api/projects/:id/rules`、`/rules/file?path=…` | 项目本地规则清单及文件读取，不修改规则 |
| models show | GET `/api/projects/:id/answer-models` | 当前项目模型集合及阈值 |
| material text | GET `/api/workflows/:id/materials/:materialId/extracted-text?redacted_only=true` | 只读当前脱敏正文 |
| attempt show/wait | GET `/api/attempts/:id?wait_ms=…`；默认wait加`view=status` | wait只返回元信息；show／wait --full读取完整结果；一秒轮询在`server/attempts.ts` |
| step dispatch | POST `/api/projects/:id/steps/:ordinal/run-batch` | 指定范围的单一步骤派发；不修改步骤设置 |
| project sync | POST `/api/projects/:id/sync-folder` | 显式同步；可能改变来源清单及下游有效性 |
| result list | GET `/api/results` | 当前有效达标成果摘要 |
| export list/create | GET `/api/projects/:id/exports`、POST `/api/projects/:id/export` | 查询/显式生成Excel |
| artifact/export download | GET `/api/artifacts/:id/download`、`/api/exports/:id/download` | 显式下载到新文件，不覆盖已有文件 |
| export failed | GET 项目、工作流、精确尝试及产物下载 API | 按当前 `repair` 判定导出到 `assets/未达标题目/`，含出题、逐模型作答和评分；不写数据库 |
| export review | 同上，须指定题目 ID | 将已评分的指定题目导出到同一复核目录；保留真实 `accepted`／`repair` 判定 |
| monitor show | GET `/api/monitor` | 运行监控快照，不等于供应商生成进度 |
| 主项目和期次 | GET `/api/project-groups`、GET `/api/project-groups/:id/phases`、PATCH `/api/projects/:id/phase-identity` | 归组、期次导航及显式期次身份维护；期次身份是写接口；不改题目工作流结果 |
| 全局材料库 | `/api/material-library/*`、`/api/projects/:id/material-candidates`、`loaded-materials`、`material-uses` | 包、不可变版本、提取/脱敏任务、原件预览、期次加载与使用状态；按 `server/material-library/README.md` 导航 |
| 恢复与复核 | `/api/workflows/:id/authoring-results/:attemptId/restore`、`authoring-direction`、`withdraw-archive`、`hooks`；`/api/hooks/:id/retry`、`/api/attempts/:id/resume-hooks`；材料库`/redactions/:id/revalidate` | 对象ID明确后显式恢复；参数及副作用见[CLI恢复说明](../cli/README.md#显式恢复与交付确认)及当前路由 |
| 旧材料导入 | `/api/projects/:id/legacy-materials`、`legacy-material-imports` | 预检并将旧入库原件/提取文本同步到全局材料库；来源摘要核验后激活 |

## CLI 工具地图

CLI 包装现有 API 与本机文件操作；没有自己的数据库、业务队列、模型规则或达标算法。所有实际命令以 `bun run ai-distill --help`、`cli/commands.ts`、`cli/remote-materials.ts`、`cli/remote-answers.ts` 和当前服务端路由为准。Codex 默认直接调用本机 API；用户明确要求命令行时使用 CLI。完整命令语法见 [CLI 使用说明](../cli/README.md)。

| 能力组 | CLI 命令 | 关键实现 | 调用目标/副作用 |
| --- | --- | --- | --- |
| 项目管理 | `project list/show/create/update/delete/sync` | `commands.ts`、`client.ts` | 本机工作台 API；create/update/delete/sync 是写操作，删项目要求精确名称 |
| 项目设置 | `project settings show/apply` | `commands.ts`、JSON 设置文件 | 本机 API；按 Codex、模型、步骤、作答策略顺序写入，部分成功不会回滚 |
| 项目题目与状态 | `question list/show`、`workflow status`、`rules list/file` | `commands.ts` | 本机 API；材料正文只允许 `material text --redacted-only` |
| 队列与手动建议 | `queue show/diagnose/cancel`、`advice show/generate` | `commands.ts`、`queue-diagnostics.ts` | 本机队列状态/取消及显式建议任务；不自动返修 |
| 飞书交付 | `feishu config/table/sync/sync-batch` | `feishu.ts`、`server/publishing/` | 明确目标的配置、建表与同步；保留逐目标回执，未知结果不自动重发 |
| 显式恢复 | `workflow design update/authoring restore/archive withdraw/hooks show`、`hook retry`、`attempt resume-hooks`、`library redaction revalidate` | `commands.ts` | 复用现有恢复API；副作用确认须显式传入，不自动重做模型 |
| 交付状态 | `workflow delivery show` | `commands.ts`、`server/workflow-view.ts` | 只读归档与逐目标安全回执；查询完成与外部交付完成分开 |
| 模型与运行 | `models catalog/show`、`attempt show/wait`、`monitor show` | `commands.ts`、`client.ts` | 本机 API；默认 wait 只看元信息，`--full` 才读取结果正文 |
| 工作流步骤 | `step list`、`step dispatch STEP_KEY` | `commands.ts`、`shared/step-registry.ts` | 本机 API；只派发一个可见稳定步骤，不自动推进 |
| 批次计划 | `batch create/show/skip` | `batches.ts`、`commands.ts` | 本机 JSON 文件；固定范围，不派发任务、不覆盖服务器状态 |
| 结果与交付 | `result list/show`、`export list/create/download`、`artifact download`、`siriser download` | `commands.ts`、`client.ts` | 本机 API 与显式下载；`publish_export`归档与Siriser五件套ZIP下载、Excel导出分开；Siriser下载仅取当前有效归档，不上传或提交 |
| 未达标复核 | `export failed`、`export review` | `failed-export.ts` | 读取当前绑定的题目/答案/评分并写入固定 `assets/未达标题目/`，不改数据库状态 |
| 远程材料 | `remote material start/run/status/sync` | `remote-materials.ts`、`remote-material-routes.ts`、`remote-material-operations.ts` | SSH 隧道 + 固定 token；旧材料工作流服务器入库/提取/人工声明兼容处理；sync只取回旧工作流副本，不处理全局库blob |
| 远程作答 | `remote answer start/run/status` | `remote-answers.ts`、`remote-material-routes.ts`、`answer-models/jobs.ts` | SSH 隧道 + 固定 token；服务器执行 server-owned 作答 attempt；状态查询不返回答案正文 |
| 主项目/期次 | `project-group list/phases/rename/archive/restore`、`project phase-update` | `commands.ts`、`server/project-groups.ts` | 查询和维护主项目期次身份；phase-update 有活动任务时拒绝 |
| 全局材料库 | `library package/revision/job/documents/redaction/file/processing` | `commands.ts`、`server/material-library/` | 包与版本、入库/提取/脱敏任务、正文查看、原件下载及全库处理设置 |
| 材料本地预处理 | `library files prepare`；也可直接调用既有`prepareLibraryFiles()` | `server/materials/prepare-library-files.ts`、`pdf-split.ts` | 上传/提取前按大小、页数切割PDF；生成manifest/provenance，业务写入仍经API |
| 期次材料与来源 | `project material candidates/materials/material uses/legacy-materials` | `commands.ts`、`projects-routes.ts`、`uses.ts`、`legacy-import.ts` | 候选分页、加载/选版/恢复、题目创建、永久使用台账与旧数据导入 |
| 进程输出 | `--json`、退出码、中断信号 | `index.ts` | 输出统一结果信封；中断等待不会取消已入队的持久任务 |

### 本机与远程执行边界

| 步骤/功能 | 本机 CLI/API | 服务器 CLI/API + `WORKER_MODE=server` |
| --- | --- | --- |
| 项目查询、状态、设置、题目结果读取 | 支持，通过本机 API | 远程命令不提供这一整套代理；可用隧道打开常规工作台 API |
| 入库、PDF/DOCX提取 | 本机现有 worker/API 路径 | 旧材料操作接口提交并由服务器 worker 执行 |
| 生成化名／旧声明处理 | 新库Agent化名或成功提取原文 | remote redact只支持全部附件已声明脱敏；不执行API模型脱敏或新库Agent化名 |
| 模型作答 | 本机 `execution_target=local` 队列 | 支持 `execution_target=server`，请求键用于幂等关联 |
| Agent/Codex 出题 | 走本机作者执行链 | 不支持；server worker 不领取 Agent 队列 |
| 独立评分、达标判定 | 走本机/API配置的现有链 | 不支持；服务器 worker 不领取评分或判定队列 |
| 归档、Excel、未达标导出 | 本机/API现有功能 | 不由 remote CLI 工作流命令执行 |

远程 worker 必须满足部署代码、迁移、共享数据库、服务器来源路径、token 及 worker 模式等条件。CLI 源码存在或本地类型检查通过，都不能证明远程实例已经部署可用；部署验收另行记录。

## 修改位置地图

| 要改什么 | 首先查看/修改 | 关联核对 |
| --- | --- | --- |
| 用户范围、目标步骤、停止或异常处理规则 | `skill/SKILL.md` | API真实能力、本文、架构说明 |
| API路由、请求/响应契约 | `server/app.ts`及对应模块 | Web、Skill、CLI与对应模块 README |
| 本机CLI命令或参数 | `cli/commands.ts` | 对应API、帮助、CLI README、本地图与命令契约检查 |
| 远程材料CLI命令/同步 | `cli/remote-materials.ts` | `server/remote-material-routes.ts`、`remote-material-operations.ts`、`.env.example`、部署说明 |
| 远程作答CLI命令/状态恢复 | `cli/remote-answers.ts` | `server/remote-material-routes.ts`、`server/answer-models/jobs.ts`、`server/worker.ts` |
| 本轮范围、分组及跳过记录 | 当前任务运行记录 | Skill规则；权威状态仍以API为准 |
| 请求/响应错误或本机限制 | `cli/client.ts` | `client.test.ts`，不得新增凭证读取 |
| 退出码或进程信号 | `cli/index.ts` | 命令信封、CLI README |
| 步骤就绪/阻断投影 | `server/project-folders.ts`、`workflow-view.ts` | API、Web与可选CLI共用口径 |
| 新步骤身份 | `shared/step-registry.ts` | 服务端装配、worker、持久化兼容、CLI、Skill步骤卡 |
| 项目策略或交付注册 | [lifecycle/projects](../server/lifecycle/projects/README.md)、[生命周期](../server/lifecycle/README.md) | 建题/出题/转换/作答/评分与交付调用点；CLI经相同API，不另注册项目规则 |
| Agent执行或配置 | [server/agent](../server/agent/README.md) | 独立任务、项目/步骤覆盖、请求/返回模型身份；全局配置/测试目前用HTTP |
| API模型连接或调用 | [server/llm-api](../server/llm-api/README.md) | 作答/API评分/项目钩子复用，CLI不直接调用模型；API目录以HTTP接口为准 |
| 模型作答/评分/达标逻辑 | `server/answer-models/`、`scoring/`、`decisions/` | 当前绑定、逐模型结果、对应模块README与测试 |
| 任务执行或恢复问题 | `server/worker.ts`、`worker-pool.ts`及对应业务jobs | 先按workflow/attempt ID查日志，不直接改数据库状态 |

维护时先核对源码与模块README；历史证据只说明当时范围。操作Skill不存当前题目、附件、评分报告或密钥。

飞书通用远端操作见[toolSkills/feishu-operations](../toolSkills/feishu-operations/README.md)：表/字段/记录/视图/附件CLI，不是第二套队列。豆包归档/补传仍由原工作流入口触发，服务端调用此通用CLI。

### 可选材料整理与使用范围

材料库`preparation.ts`从数据库加载正文，经共用文本投影内联给Agent，一次调用提供材料包总摘要、逐份材料摘要/标签和多个可支持范围组合；CLI `library prepare`见[CLI](../cli/README.md#可选材料整理)。建题按来源自动冻结结果给出题Agent参考，完整附件仍是事实依据；作者自行确定最终组合，作答和评分不读取整理建议。缺失或失败可跳过，不过滤材料、不阻断建题。

整理重跑与来源筛选：CLI `library prepare start --force`、`list --revision/--redaction/--project`对应现有prepare及preparations接口；`diagnose`只读进度、错误码及计数。完整参数与预算唯一说明见[CLI材料整理](../cli/README.md#可选材料整理)。
