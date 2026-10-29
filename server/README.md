# 服务端与 worker

Bun/Hono 提供本地 HTTP API，PostgreSQL 保存业务意图、执行归属和结果；local模式由每机SQLite持久化排队、独立worker消费。`app.ts` 负责装配接口，业务模块负责输入冻结、执行和结果提交；请求等待时间不决定后台任务生命周期。

材料库版本上传的HTTP限制与200MiB整包业务上限对齐，另留1MiB封装开销；其他接口仍保持100MiB加封装开销，单文件限制由validation.ts校验。

## 目录关系

| 模块 | 职责 |
| --- | --- |
| [material-library/](material-library/README.md) | 全局材料包、版本、处理任务、期次加载、永久使用记录及题目来源快照 |
| [materials/](materials/README.md) | 旧工作流提取/脱敏及新材料库复用的解析、映射、结构与 DOCX 工具 |
| [revision-advice/](revision-advice/README.md) | 手动返修建议、来源绑定、独立本机队列及出题读取 |
| [authoring/](authoring/README.md) | 出题队列、作者执行、内容契约及结果校验 |
| [answer-models/](answer-models/README.md) | 模型目录/项目集合、作答输入隔离、逐模型队列和结果 |
| [scoring/](scoring/README.md) | 同版匿名评分输入、Codex/API执行、报告解析及版本校验 |
| [decisions/](decisions/README.md) | 按项目配置解释评分指标，同依据及当前结果复用原判定，变化时更新达标依据 |
| [document-generation/](document-generation/README.md) | 各项目共用DOCX与XLSX字节生成、表格显示布局，不承担项目交付资格 |
| [publishing/](publishing/README.md) | 持久派发第八步、复核达标、调用各项目交付、产物齐全后记录归档/撤回及下载五件套 |
| [reporting/](reporting/README.md) | 单题/项目 Excel、版本一致性、费用与统计投影 |
| [agent/](agent/README.md)、[codex/](codex/README.md) | 本地 Agent 任务契约及底层 Codex CLI/配置；作者和盲作答/评分使用不同隔离策略 |
| [llm-api/](llm-api/README.md) | API配置、凭证、JSON/SSE共用的消息字段拒绝规则及本机请求槽位；model返回值未知时为null |
| [skill-generation/](skill-generation/README.md) | 项目规则生成候选 Skill、来源校验与采用 |
| [monitoring/](monitoring/README.md) | 本机资源、worker、活动尝试和安全队列状态 |

## 根层生产文件

| 文件 | 入口、调用方与用途 |
| --- | --- |
| `index.ts` | API进程入口；创建pool/app、配置HOST/PORT，可选提供web/dist，退出时关闭资源 |
| `app.ts` | `createApp()`：请求/错误/日志中间件与项目、配置、文件和模块路由装配；题目附件全文接口按共享题快照读取冻结的原文或脱敏正文 |
| `paths.ts` | `repositoryRoot`、存储路径，以及项目目录的 `resolveProjectPath()` / `projectPathReference()`：项目配置保存仓库相对引用，运行时解析本机目录；存储路径保持原语义 |
| `db.ts` | `createPool()`：启用TLS证书验证及可选channel binding；连接/查询安全日志，不输出SQL正文或参数。`readStatusRows()`供取消轮询与worker统计复用有界只读事务，失败连接销毁 |
| `migrate.ts` | 人工迁移入口：互斥事务内按完整文件名执行所有未登记SQL；API健康检查不执行迁移 |
| `concurrency.ts` | `readConcurrencySettings()` / `saveWorkerConcurrencySettings()` 管理本机持久并发；`AgentConcurrencyGate` 协调同一STORAGE_DIR下的Agent槽位 |
| `worker.ts` | 进程入口：按模式、执行端和任务provider装配材料/API/Agent/交付；local队列兼容历史hook任务。限定临时worker可用 `WORKER_BATCH_STDIN=1` 接受自有父执行器的管道EOF，先停领再等待在途完成；常驻worker默认不启用 |
| `worker-pool.ts` | `runWorkerPool()` 控制循环并发、空闲/失败退避；`createFairQueueHandler()` 公平轮转业务队列并在轮转间检查停止；`createWorkerShutdown()` 一次性广播停止、记录请求及10秒未完成诊断，不强杀进程 |
| `task-signal.ts` | `watchTaskCancellation()` 合并查询持久任务状态并取消失效执行；状态SQL服务端限时2秒，BEGIN/SET/SELECT/COMMIT及回滚逐次驱动限时3秒，读取失败不误取消模型；`withTaskSignal()` 传递调用链信号 |
| `attempt-heartbeat.ts` | 出题/作答/评分共用10秒心跳；防止重叠写入，去重失败并记录恢复；调用方在finally停止，不改变任务状态或重试模型 |
| `external-call.ts` | `runExternalCall()` 将一次调用关联到attempt或library_job及call_id，传递安全日志；不重试收费请求 |
| `logging.ts` | `createStructuredLogger()`、`logEvent()` 与上下文入口：安全字段投影、JSONL轮转保留、健康及致命错误记录 |
| `validation.ts` | HTTP请求预算（普通101MiB、库级版本上传201MiB含1MiB封装余量；业务文件仍限100/200MiB）、UUID/文字/标签/source key及PDF/DOCX/TXT/MD类型和大小边界；不代替内容解析 |
| `project-groups.ts` | `resolveProjectGroup()` / `registerProjectGroupRoutes()`：稳定主项目、期次导航、归档恢复；`updatePhaseIdentity()` 修改身份前后比较业务摘要 |
| `project-folders.ts` | 旧目录扫描/登记；`workflowStepReadiness()` 共用前置条件；`projectStepSummary()` 汇总；阶段配置校验和批量分块 |
| `material-package-questions.ts` | 旧项目内材料包兼容：列成功脱敏版本并复制私有题目快照；不等同于全局材料库包 |
| `question-materials.ts` | `readQuestionMaterials()`：校验共享材料题冻结的原文/脱敏来源；数据库先读身份/摘要元数据，优先复用 `STORAGE_DIR` 下本题同摘要文件，缺失/损坏/越界时仅回读缺少的正文；保留完整来源及内容核验。有限事件 `material.snapshot.read` 记录命中方式与回读正文/索引的UTF-8字节数（不含元数据和协议开销）。可选第三参数指定隔离存储根；旧题脱敏读取不变，新库缺快照不回退旧ordinal9 |
| `intake.ts` | `receiveMaterials()`：旧上传/目录接收、原件及指纹、材料修改后下游失效；库级上传另由material-library管理 |
| `intake-jobs.ts` | `enqueueIngestion()` / `enqueueIntake()` 与 `runNextIntake()`：持久目录接收及接续提取，按执行端领取 |
| `system-step-prompts.ts` | 当前出题/作答/评分默认提示词与历史脱敏提示词兼容读取；出题专用model/effort独立保存，新期步骤4显式复制，既有期次与其他模型配置不回写 |
| `rule-files.ts` | 工作区清单、有效Skill选择、实际文件读取/摘要校验及受限资料写入；独立历史审计/报表可校验Skill指纹，通用归档不据此增加门槛 |
| `rules.ts` | `readProjectRules()`、`editProjectRuleFile()`、`adoptProjectSkill()`：资料管理和候选采用，期次覆盖优先；不向评分者传入Skill |
| `rule-loading.ts` | 停用的编号规则绑定兼容入口；明确410，不创建新规则版本或隐藏步骤 |
| `step-dispatch.ts` | `dispatchWorkflowStep()`：稳定ordinal映射到现有业务入口，本身不做队列或达标判断 |
| `workflow-execution-routes.ts` | `registerWorkflowExecutionRoutes()`：单题/批量派发、有限等待、attempt视图；逐题返回资格和失败原因 |
| `attempts.ts` | `waitForAttempt()` / `waitDuration()`：只读有限等待；`cancelWaitingScore()` 取消未领取评分；`cancelStoppedExecutorAttempt()` 在用户确认原机停止后显式终止未知旧尝试，不自动重跑 |
| `workflow-view.ts` | 轻量列表、按需详情及安全尝试摘要投影；当前模型结果按attempt引用，不按历史时间猜测；归档投影含最近与逐目标飞书安全回执，供[CLI交付查询](../cli/README.md#显式恢复与交付确认)使用 |
| `generated-data.ts` | `clearGeneratedData()`：无活动任务时重置旧工作流生成数据和管理文件；先隔离文件，数据库失败恢复，不修改用户来源目录 |
| `workflow-hooks.ts` | 冻结可信项目脚本和声明依赖，在私有临时目录运行或请求受控API复核，只收集附加结果 |
| `lifecycle/` | [同步可插拔增强层](lifecycle/README.md)：各步骤事件注册、顺序回调、按项目key分派；项目专属注册位于lifecycle/projects，公共步骤不写项目分支；兼容旧脚本 |
| `workflow-hook-jobs.ts` | 旧导入路径兼容，统一转到 lifecycle/scripts |
| `workflow-hook-worker.ts` | 历史记录有效性SQL与旧消费者；本机队列仍可按明确ID消费历史hook，主worker不再新增独立旧hook轮询池 |
| `workflow-hook-routes.ts` | 受限钩子记录读取、旧原尝试续跑与同步增强补执行；未知主调用不自动重新执行 |
| `remote-material-routes.ts` | 显式server执行端和token保护的旧材料组合操作/远程作答/文件取回入口 |
| `remote-material-operations.ts` | 持久编排旧工作流入库/提取/人工已脱敏声明，固定request key恢复；不同于library_jobs |

## 根层测试文件

同名 `*.test.ts` 验证上述文件的公开契约；其职责、真实/注入执行边界写在文件头和测试中。存在文件不代表本轮运行。以下跨入口测试另说明归属：

| 文件 | 验证对象 |
| --- | --- |
| `app.test.ts`、`routes.test.ts` | Hono装配、请求校验、项目/模型/材料/产物路由、状态投影及健康响应 |
| `extracted-text.test.ts` | 单附件已提取/脱敏正文HTTP读取与原文隔离 |
| `rule-currentness.test.ts`、`rule-files.test.ts`、`rules.test.ts` | 任务文件指纹、旧快照自洽、候选采用与导出失效、越界及并发编辑 |
| `project-folders.test.ts` | 旧目录发现、配置/标签、步骤就绪和共享快照适用性 |
| `project-groups.test.ts`、`question-materials.test.ts` | 主项目/期次身份与不可释放使用账；共享/旧题来源和原文快照边界 |
| `material-package-questions.test.ts` | 旧材料包成功脱敏版本生成独立题目，不再运行脱敏 |
| `remote-material-operations.test.ts` | 远程路由鉴权、请求复用、来源变化终止及成功文件清单 |
| `workflow-view.test.ts` | 轻量/完整读取白名单、当前结果和已有状态快照复用 |
| `attempts.test.ts` | 状态视图长轮询、超时不改写任务、取消及时唤醒 |
| `concurrency.test.ts` | 并发配置校验、持久槽位跨连接互斥和取消退出 |
| `db.test.ts` | 数据库URL/TLS配置及日志中SQL值、原始错误隔离 |
| `external-call.test.ts` | 外部调用结果关联及workflow/library job身份互斥 |
| `generated-data.test.ts` | 工作流产物清理、来源保护、符号链接边界及数据库失败回滚 |
| `intake.test.ts`、`intake-jobs.test.ts` | 当前附件移除后的入库状态，以及领取后停机时入库任务恢复 |
| `logging.test.ts` | 安全字段投影、异步上下文、轮转保留及多进程写入隔离 |
| `step-dispatch.test.ts` | 稳定ordinal到业务处理器的映射及不支持步骤拒绝 |
| `task-signal.test.ts` | 持久任务取消到AbortSignal的传递和轮询故障隔离 |
| `attempt-heartbeat.test.ts` | 以定时器、数据库及日志替身核对间隔、无重叠、失败/恢复和停止，不连接真实数据库 |
| `rule-loading.test.ts` | 旧编号规则入口明确停用，不重建历史步骤 |
| `workflow-hook-jobs.test.ts` | 同步增强/主调用检查点、历史声明兼容、恢复和主结果不重复执行 |
| `workflow-hook-routes.test.ts` | 旧主尝试续跑与同步单增强补执行的输入、状态及副作用边界 |
| `workflow-hook-worker.test.ts` | 历史hook消费者归属、独立结果及停机恢复 |
| `workflow-hooks.test.ts` | 钩子冻结输入、环境白名单、进程取消和声明副作用校验 |
| `worker-pool.test.ts` | worker并发、资源暂停/恢复、停机与公平队列轮转 |

## 当前业务关系

`project_groups` 是稳定主项目，`projects` 是期次执行容器。新界面默认 `library_v1`：材料处理在全局库进行，期次加载可用版本后建立题目。出题设置默认 `redacted`，也可显式使用完整提取的 `original`；新题冻结来源，后续设置/库版本变化不切换旧题。`question-materials.ts` 为出题、作答、评分与交付共用读取入口。

旧 `question_folders` 和旧项目内 `material_packages` 继续兼容。共享材料快照也可供旧项目使用，以题目来源判断，不按项目名称或目录猜测。稳定步骤身份由 `shared/step-registry.ts` 定义：新库题通常只执行4–8，旧材料工作流执行入库/提取/脱敏；内部ordinal2/3及旧10不重编号、不作为新流程独立可见步骤。

作答不接收Rubric、标答、思路或项目Skill。评分以同版本题面/Rubric/匿名答案/对应来源附件及评分步骤指令执行，默认不提供标答；显式报告校准政策是例外。出题有效Skill来自期次覆盖或主项目回退，普通出题的工具能力不继承盲作答/评分隔离限制。

普通步骤由用户派发；评分完成后的达标判断读取项目模型集合及策略，不把历史两模型/55%示例写成当前默认。归档先复核版本再运行项目脚本；Work五件套不以Harbor身份为前提。归档、使用账中的已提交、平台提交和验收不是同一状态，详情见对应模块。

## worker、并发与恢复

模式及执行端的实际注册以 `worker.ts` 为准：

- `all` 是未设置时的兼容模式，处理本机材料、API、Agent及交付。local队列模式还保留历史hook路由；新生命周期脚本在原任务中同步等待。
- `local` 处理本机材料、Agent、交付及带本地脚本的API任务；local队列还可消费历史hook记录。不能仅凭模式名称认定所有API任务都可领取。
- `api` 不运行Agent或本地脚本；按执行端处理可领取的API任务，server目标还可处理服务器材料/组合操作。
- `materials` 必须是server目标，处理服务器材料、人工声明及旧组合操作；不作答或评分。
- `server` 必须是server目标，处理服务器材料/人工声明和无本地钩子的API作答，不运行Agent和评分。
- 可选 `WORKER_WORKFLOW_IDS` 接收逗号分隔的工作流 UUID；设置后，仅处理范围内工作流的出题、作答、评分及交付；local队列还允许显式返修建议。材料、脱敏、项目Skill和历史hook任务不进入该范围。未设置时保持上述默认行为。该范围只限制领取和中断恢复，不改变已冻结任务输入。

新材料库任务按internal/API/Agent lane加入相应公平队列；legacy任务还检查provider、execution_target和钩子归属。配置保存不代表每个进程已经加载。并发逐项优先读取 `.env`／进程环境中的 `AGENT_CONCURRENCY`、`LLM_API_CONCURRENCY`（1–32），未设置或空白才读取 `STORAGE_DIR/.concurrency/agent-slots.sqlite3` 中的持久设置，均缺失时默认Agent2/API8；非法环境值直接报错，两项均配置时不读取持久设置。修改环境变量后须重启API和worker；页面保存的是回退设置，被环境变量覆盖的项不因保存而改变生效值；页面可设置Agent 1–6、API 1–8；范围以 `concurrency.ts` 的常量为准，环境兼容范围另见该文件，变更后按接口的restart_required核对进程。Agent槽位协调同一存储下的进程；API传输槽位见llm-api模块，不宣称跨机器全局限制。内存监控可能暂停新领取，不终止已执行任务。

`steps`是当前状态，`step_attempts`是尝试历史。`waiting`须结合活动尝试、就绪原因和worker归属判断；HTTP202只表示已接受或等待未终结。按原attempt/job/request key恢复，不因超时重新派发。单题与批量资格分别由入口及业务模块复核；批量一题失败不把其余结果改成失败。独立评分已完成但缺少明确可比较分数、且达标仍waiting时，可由用户显式重新评分；旧validation标记本身不是达标门槛。已有达标或归档结果仍受重复派发保护，不自动重试。

钩子采用独立检查点和事件，不恢复通用自动返修链。可选033表缺失不阻断无钩子旧流程；启用钩子、迁移和恢复副作用分别遵守对应接口与授权。

## 读取、日志与维护

首屏列表/状态使用服务端白名单和批量快照；正文、历史及材料版本按需读取。`GET /api/attempts/:id?view=status`不读取结果正文，CLI等待默认使用该视图；完整内容由show/full显式读取。普通文件下载不证明内容质量或平台成功。

共用安全日志入口为 `logging.ts`，默认位于 `<STORAGE_DIR>/logs/<UTC日期>/`。请求通过 `X-Request-ID`、attempt/job/call ID关联。普通JSONL落盘错误、指定数据库慢查询/连接等待告警，以及精确白名单中的停止生命周期、材料取消和恢复降级事件；下述有限执行里程碑也持久化，其他成功/逐token等进度日志不落盘；不记录材料、题面、提示词、答案、SQL参数或凭证。MinerU结果下载失败可记录下载子阶段、HTTP状态或经过格式白名单过滤的网络错误码，不记录原始错误消息、响应正文或签名地址。Codex私有事件和业务报告不是普通日志。命令和限制见 [诊断脚本](../scripts/diagnostics/README.md)；健康和`/api/monitor`状态不能证明供应商仍在生成。

修改公共契约同时核对前端、CLI、路由、任务输入快照及历史兼容。文档中的配置/迁移/启动命令是参考，授权边界见 [AGENTS.md](../AGENTS.md)。本文件不声明某次数据库、真实模型或外部平台验收已完成；历史证据按其时间和范围单独阅读。

### 空队列探测

worker 对同类队列的并发可用性查询共用一个进行中的探测；空结果最多复用3秒，与原空闲轮询间隔一致。正结果不缓存，实际领取事务、执行并发、公平轮转及过期任务恢复保持独立。此优化不增加并发上限，也不共用已领取任务。

## 每机独立执行

`execution-queue/`提供每机SQLite执行队列、归属登记与结果对账；local模式不再扫描共享等待队列，PG仍保存业务状态与历史。启用、兼容、取消及切换的唯一说明见[每机执行队列](execution-queue/README.md)。API/worker入口默认local，显式legacy用于升级过渡；各台电脑需更新并重启，隔离测试不代表实体双机已启用。

系统出题专用默认存于`system_codex_config.authoring_defaults`（048迁移）；系统步骤提示词接口一并读取/原子保存，新期将显式创建设置或系统出题默认写入步骤4。不回写已有期次，不改变作答、评分、脱敏默认。

`project-creation-recovery.ts`提供只读创建回执恢复；网页与CLI调用`POST /api/projects/creation-receipt`，使用与创建相同的目录规范化，并核对主项目/期号、关键字段及显式出题默认值。此接口只SELECT，不重新创建或删除。项目详情的`skill_exists`按实际生效的本期覆盖/共享路径判断，路径读取失败作为局部提示，不整体阻断详情。

达标判断“就绪”需要已有可比较最终评分；只有评分执行成功、但未返回最终总分的记录不显示可判断，而提示重新评分。此资格检查不复算条目或增加AI复审。

作答模型集合切换支持显式 `future_only:true`：后续派发用新集合，已有结果和在途任务按冻结集合继续，由 [作答模块](answer-models/README.md#仅后续作答切换模型) 统一说明。启用前须加载所有相关API/worker代码；不能向旧进程发送该标记并假定其会保留结果。

## 本机容量、手动建议与有界观测

[手动返修建议](revision-advice/README.md)为独立的用户派发功能；050仅新增任务结构和归属约束，不恢复自动返修链。批量出题/作答/评分遇到当前accepted题目返回already_accepted，不创建尝试或清除结果；单题显式重出仍沿用原行为。

普通结构化日志除错误、服务生命周期和数据库慢/等待告警外，还持久化有限执行里程碑：attempt入队/复用/领取/输入校验/完成、外部调用开始/完成、心跳失败及恢复、连接恢复。MinerU另记录上传/轮询/下载阶段、供应商状态变化、提取完成和CLI回退，不逐次记录相同轮询状态；私有批次定位见[PDF提取模块](materials/pdf-extraction/README.md)。工具/token/页进度仍不持久化。连接诊断增加获取前后池总数/空闲数/等待数及新连接标记；流错误仅保留事件数/字节数/DONE与finish状态等安全标量，不保留正文或原始响应。没有结束事件不证明上游仍在生成。

手动建议050与钩子033属于按功能启用的可选结构，缺少它们不使既有流程健康检查失败；建议GET的available与派发校验单独判断该功能是否可用。

长期运行的本机队列监控按状态读取，登记/取消/结果对账按稳定键每类每轮最多20条；不会为每轮监控加载全部终态历史。HTTP监控保留材料库历史数量聚合，显式队列管理仍可查看历史。详情见[周期读取](execution-queue/README.md#长期运行的周期读取)。取消状态读取按pool合并且单飞，模型心跳保持原间隔；性能改动不代替真实网络与供应商故障定位。

HTTP监控读取另有同pool/同范围在途合并和每条SQL取得连接后5秒的驱动读取截止；本机空活动集合不查PG，本机库明细带任务ID范围。没有缓存历史状态，不把空本机集合解释为PG健康；获取连接仍遵守原15秒上限。失败连接销毁及接口降级见[监控说明](monitoring/README.md#http监控读取的负载与截止)。

`GET /api/attempts/:id?view=status`包含`heartbeat_at`（数据库最后一次任务心跳），轻量读取不包含结果正文。陈旧心跳只作为诊断证据，不在读取时修改状态、接管其他执行器或重放未知调用；心跳新鲜同样不能证明供应商仍在生成。

## 未领取评分的显式取消

`POST /api/attempts/:id/cancel-waiting-score` 接收且仅接收 `{workflow_id,executor_id}`，两者及路径ID均为UUID。用于原执行端不能消费的未开始评分；不认领或迁移旧任务，不自动创建替代任务。要求当前最新ordinal6尝试仍为waiting、heartbeat_at及result均为NULL，归属匹配、当前评分步骤waiting且题目未达标。

事务先锁workflow再锁attempt，与评分worker领取使用相同行锁；若worker已领取，取消拒绝。锁等待2秒、语句10秒截止。只将指定attempt记skipped并保留原result/输入/归属及答案，步骤保持waiting，下一次评分仍需普通显式派发。原机旧队列不能再将skipped尝试从waiting领取，不据此修改其SQLite。running、历史有心跳、已有结果和最新身份变化均拒绝。请求回执未知时先GET原attempt，不盲目重发。

单元/HTTP替身验证输入、事务和拒绝分支；真实锁竞争和实体双机验证分别记录，不将替身通过称为跨机验收。

### 用户确认原执行端停止后的显式终止

`POST /api/attempts/:id/cancel-stopped-executor` 只接收 `{workflow_id,executor_id,expected_heartbeat_at,executor_stopped:true,acknowledge_unknown_result:true}`。调用者必须先取得用户对原机停止的确认，并告知原调用结果仍未知；不能由后台心跳超时自动调用。只适用于当前最新作答或评分（ordinal5/6），无结果、无已登记产物、无其他活动尝试，且心跳/开始时间至少陈旧5分钟。该时间沿用旧消费者失租观察窗口，本身不证明机器停止，必须同时有用户确认。

HTTP心跳精度为毫秒；在workflow/attempt行锁内核对预期心跳、归属、当前步骤及未达标状态。仅将旧尝试标skipped，保留其输入、result、归属和历史；当前步骤改waiting但不清除已有result，防止下游使用未完成结果。返回prior_outcome=unknown，不伪造供应商失败、撤销计费或读取原机私有检查点。替代尝试须随后经普通派发接口明确创建，新结果仍受当前版本绑定。若心跳已更新、旧尝试已有产物/结果，必须先核实，不继续终止。

### 容量读取的短锁等待

readActiveConcurrencyLimit的只读SQLite连接沿用槽位写连接的5秒busy_timeout，避免短写事务期间默认零等待直接抛SQLITE_BUSY。隔离跨进程150ms独占锁用例验证释放后返回原上限，不改变并发设置或槽位占用。安全日志将SQLite忙锁和worker上限不一致记录为固定reason_code，不输出原始错误。此修复不证明所有历史HTTP500或远端数据库延迟同源。

飞书交付的配置/建表/单题同步HTTP请求在`index.ts`逐请求设置180秒空闲时限，其他接口沿用60秒；CLI对应请求最长等待180秒，远端HTTP仍有90秒总截止。此设置不创建后台重试，也不扩大批次或跨项目同步范围。

`workflow-archive-guard.ts` 在派发事务中锁定工作流并检查当前归档状态：已归档题目拒绝再次出题、作答、评分、达标判定和归档（HTTP 409），不创建新尝试或清空结果。批量入口返回 `already_archived` 并继续其他题目；显式撤回归档后可返修，下载和辅助导出不受影响。

批量run-batch保留原批次读取及逐题结果顺序，入队同时最多处理2题，避免单个批量请求一次争抢全部连接；不改变worker模型执行并发。数据库慢/失败日志附加SQL内容的不可逆query_id摘要；连接占用超过1秒释放时记录db.connection.held，耗时含本地准备和SQL等待，不能直接等同慢SQL。

1—7的运行时项目策略统一由`lifecycle/steps.ts`装配，各项目在`lifecycle/projects/`注册。`emitProjectLifecycle`为各步骤按主项目key路由通知；必要纯策略、外部必需交付、可选通知分别遵守其失败语义，详见生命周期README。

页面及批量派发的active判断与业务新派发共用[他机未开始意图判据](execution-queue/README.md#他机未开始待办与本机明确派发)，共享waiting/queued不代表本机容量；旧字段保留协议兼容。

## 项目目录与多机路径

面向项目配置、API和CLI维护者。`projects.workspace_path`、`local_skill_path`及旧项目`material_root`新指定目录须在当前仓库内，保存为正斜杠仓库相对引用，例如`projects/豆包高经济价值/skill`；不保存用户名或某台机器的仓库根。API创建、修改及创建回执恢复使用同一目录校验；仅表示从绝对改相对不失效题目结果。Skill候选采用写入也使用相同保存规则。

`paths.ts`是唯一解析入口：运行时相对当前源码仓库根定位，不依赖启动cwd；仓库内绝对输入校验后转为相对引用。旧`.../ai-distill/projects/...`及`.../ai-distill/.storage/project-skills/...`配置可在其他机器映射到本机同名子树；仓库外历史目录保留原位置，不猜测搬迁。原件、产物存储和Codex凭证不应用项目路径映射，也不自动同步。旧配置只兼容读取，未批量更新数据库。

任务私有执行目录及运行时文件访问仍使用实际绝对路径；已有任务快照及摘要不批量重写。目录在另一台机器可定位不表示文件内容已经同步；材料/Skill须实际存在。新增持久化写入需用`projectPathReference()`，比较旧绑定用`comparableProjectPath()`，不能把相对配置直接传给依赖cwd的文件API。此说明不代表服务已重载或跨机业务验收。

步骤5的项目摘要仅保留提示词和流程策略，不投影旧单模型provider/model连接字段；新作答模型以本期模型集合接口为准，历史尝试和保留模式仍按各自冻结集合读取。此投影清理不改写旧配置或业务结果。

材料模型正文由shared/document-structure.ts的documentPagesToModelText统一生成：材料整理内联输入与question-materials.ts模型附件共用，后者供出题和作答使用，评分读取作答冻结正文。历史结构指纹投影与原件/DOCX结构保持独立。
