# 服务端与 worker

Bun/Hono 提供本地 HTTP API，PostgreSQL 保存业务状态和持久化任务，独立 worker 消费队列。`app.ts` 负责装配接口，业务模块负责输入冻结、执行和结果提交；请求等待时间不决定后台任务生命周期。

## 目录关系

| 模块 | 职责 |
| --- | --- |
| [material-library/](material-library/README.md) | 全局材料包、版本、处理任务、期次加载、永久使用记录及题目来源快照 |
| [materials/](materials/README.md) | 旧工作流提取/脱敏及新材料库复用的解析、映射、结构与 DOCX 工具 |
| [authoring/](authoring/README.md) | 出题队列、作者执行、内容契约及结果校验 |
| [answer-models/](answer-models/README.md) | 模型目录/项目集合、作答输入隔离、逐模型队列和结果 |
| [scoring/](scoring/README.md) | 同版匿名评分输入、Codex/API执行、报告解析及版本校验 |
| [decisions/](decisions/README.md) | 按项目配置解释评分指标并保存达标依据 |
| [document-generation/](document-generation/README.md) | 各项目共用DOCX与XLSX字节生成、表格显示布局，不承担项目交付资格 |
| [publishing/](publishing/README.md) | 复核达标、调用项目交付、记录归档/撤回及下载五件套 |
| [reporting/](reporting/README.md) | 单题/项目 Excel、版本一致性、费用与统计投影 |
| [agent/](agent/README.md)、[codex/](codex/README.md) | 本地 Agent 任务契约及底层 Codex CLI/配置；作者和盲作答/评分使用不同隔离策略 |
| [llm-api/](llm-api/README.md) | API供应商配置、凭证引用、消息/JSON传输、完整响应和本机请求槽位 |
| [skill-generation/](skill-generation/README.md) | 项目规则生成候选 Skill、来源校验与采用 |
| [monitoring/](monitoring/README.md) | 本机资源、worker、活动尝试和安全队列状态 |

## 根层生产文件

| 文件 | 入口、调用方与用途 |
| --- | --- |
| `index.ts` | API进程入口；创建pool/app、配置HOST/PORT，可选提供web/dist，退出时关闭资源 |
| `app.ts` | `createApp()`：请求/错误/日志中间件与项目、配置、文件和模块路由装配；题目附件全文接口按共享题快照读取冻结的原文或脱敏正文 |
| `paths.ts` | `repositoryRoot`、`resolveRepositoryPath()`、`storageDirectory()`：路径相对仓库解析，绝对路径保持 |
| `db.ts` | `createPool()`：启用TLS证书验证及可选channel binding；连接/查询安全日志，不输出SQL正文或参数 |
| `migrate.ts` | 人工迁移入口：互斥事务内按完整文件名执行所有未登记SQL；API健康检查不执行迁移 |
| `concurrency.ts` | `readConcurrencySettings()` / `saveWorkerConcurrencySettings()` 管理本机持久并发；`AgentConcurrencyGate` 协调同一STORAGE_DIR下的Agent槽位 |
| `worker.ts` | 进程入口：按模式、执行端和任务provider注册材料/API/Agent及钩子消费者，传播停止信号 |
| `worker-pool.ts` | `runWorkerPool()` 控制循环并发、空闲/失败退避；`createFairQueueHandler()` 公平轮转业务队列 |
| `task-signal.ts` | `watchTaskCancellation()` 合并查询持久任务状态并取消失效执行；`withTaskSignal()` 传递调用链信号 |
| `external-call.ts` | `runExternalCall()` 将一次调用关联到attempt或library_job及call_id，传递安全日志；不重试收费请求 |
| `logging.ts` | `createStructuredLogger()`、`logEvent()` 与上下文入口：安全字段投影、JSONL轮转保留、健康及致命错误记录 |
| `validation.ts` | UUID/文字/标签/source key及PDF/DOCX/TXT/MD类型和大小边界；不代替内容解析 |
| `project-groups.ts` | `resolveProjectGroup()` / `registerProjectGroupRoutes()`：稳定主项目、期次导航、归档恢复；`updatePhaseIdentity()` 修改身份前后比较业务摘要 |
| `project-folders.ts` | 旧目录扫描/登记；`workflowStepReadiness()` 共用前置条件；`projectStepSummary()` 汇总；阶段配置校验和批量分块 |
| `material-package-questions.ts` | 旧项目内材料包兼容：列成功脱敏版本并复制私有题目快照；不等同于全局材料库包 |
| `question-materials.ts` | `readQuestionMaterials()`：校验共享材料题冻结的原文/脱敏来源，或读取旧题成功脱敏；新库缺快照不回退旧ordinal9 |
| `intake.ts` | `receiveMaterials()`：旧上传/目录接收、原件及指纹、材料修改后下游失效；库级上传另由material-library管理 |
| `intake-jobs.ts` | `enqueueIngestion()` / `enqueueIntake()` 与 `runNextIntake()`：持久目录接收及接续提取，按执行端领取 |
| `system-step-prompts.ts` | 系统四类默认提示词读取/保存；新项目创建时复制，既有项目与在途尝试不被全局修改回写 |
| `rule-files.ts` | 工作区清单、有效Skill选择、实际文件读取/摘要校验及受限资料写入；归档校验历史Skill指纹自洽 |
| `rules.ts` | `readProjectRules()`、`editProjectRuleFile()`、`adoptProjectSkill()`：资料管理和候选采用，期次覆盖优先；不向评分者传入Skill |
| `rule-loading.ts` | 停用的编号规则绑定兼容入口；明确410，不创建新规则版本或隐藏步骤 |
| `step-dispatch.ts` | `dispatchWorkflowStep()`：稳定ordinal映射到现有业务入口，本身不做队列或达标判断 |
| `workflow-execution-routes.ts` | `registerWorkflowExecutionRoutes()`：单题/批量派发、有限等待、attempt视图；逐题返回资格和失败原因 |
| `attempts.ts` | `waitForAttempt()` / `waitDuration()`：状态或完整结果的有限HTTP等待，中断不取消后台任务 |
| `workflow-view.ts` | 轻量列表、按需详情及安全尝试摘要投影；当前模型结果按attempt引用，不按历史时间猜测 |
| `generated-data.ts` | `clearGeneratedData()`：无活动任务时重置旧工作流生成数据和管理文件；先隔离文件，数据库失败恢复，不修改用户来源目录 |
| `workflow-hooks.ts` | 冻结可信项目脚本和声明依赖，在私有临时目录运行或请求受控API复核，只收集附加结果 |
| `workflow-hook-jobs.ts` | 钩子冻结/同步执行、主检查点、异步登记和中断恢复；无钩子不查询可选新表 |
| `workflow-hook-worker.ts` | local/all异步附加任务消费；不改主阶段成绩，未知非幂等副作用转待核 |
| `workflow-hook-routes.ts` | 受限钩子记录读取、原尝试续跑与异步重试；未知主调用不自动重新执行 |
| `remote-material-routes.ts` | 显式server执行端和token保护的旧材料组合操作/远程作答/文件取回入口 |
| `remote-material-operations.ts` | 持久编排旧工作流入库/提取/API脱敏，固定request key恢复；不同于library_jobs |

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
| `rule-loading.test.ts` | 旧编号规则入口明确停用，不重建历史步骤 |
| `workflow-hook-jobs.test.ts` | 同步/异步钩子检查点、恢复和主结果不重复执行 |
| `workflow-hook-routes.test.ts` | 钩子续跑与异步重试路由的输入、状态及副作用边界 |
| `workflow-hook-worker.test.ts` | worker钩子lane归属、异步结果隔离及停机恢复 |
| `workflow-hooks.test.ts` | 钩子冻结输入、环境白名单、进程取消和声明副作用校验 |
| `worker-pool.test.ts` | worker并发、资源暂停/恢复、停机与公平队列轮转 |

## 当前业务关系

`project_groups` 是稳定主项目，`projects` 是期次执行容器。新界面默认 `library_v1`：材料处理在全局库进行，期次加载可用版本后建立题目。出题设置默认 `redacted`，也可显式使用完整提取的 `original`；新题冻结来源，后续设置/库版本变化不切换旧题。`question-materials.ts` 为出题、作答、评分与交付共用读取入口。

旧 `question_folders` 和旧项目内 `material_packages` 继续兼容。共享材料快照也可供旧项目使用，以题目来源判断，不按项目名称或目录猜测。稳定步骤身份由 `shared/step-registry.ts` 定义：新库题通常只执行4–8，旧材料工作流执行入库/提取/脱敏；内部ordinal2/3及旧10不重编号、不作为新流程独立可见步骤。

作答不接收Rubric、标答、思路或项目Skill。评分以同版本题面/Rubric/匿名答案/对应来源附件及评分步骤指令执行，默认不提供标答；显式报告校准政策是例外。出题有效Skill来自期次覆盖或主项目回退，普通出题的工具能力不继承盲作答/评分隔离限制。

普通步骤由用户派发；评分完成后的达标判断读取项目模型集合及策略，不把历史两模型/55%示例写成当前默认。归档先复核版本再运行项目脚本；Work五件套不以Harbor身份为前提。归档、使用账中的已提交、平台提交和验收不是同一状态，详情见对应模块。

## worker、并发与恢复

模式及执行端的实际注册以 `worker.ts` 为准：

- `all` 是未设置时的本机兼容模式，注册本机材料、API、Agent及钩子队列。
- `local` 注册本机材料、Agent和钩子，也注册受本地钩子归属条件筛选的API队列；不能仅凭模式名称认定所有API任务都可领取。
- `api` 不运行Agent或本地脚本；按执行端处理可领取的API任务，server目标还可处理服务器材料/组合操作。
- `materials` 必须是server目标，处理服务器材料、API脱敏及旧组合操作；不作答或评分。
- `server` 必须是server目标，处理服务器材料/API脱敏和无本地钩子的API作答，不运行Agent和评分。
- 可选 `WORKER_WORKFLOW_IDS` 接收逗号分隔的工作流 UUID；设置后，worker 只领取这些工作流的出题、作答和评分任务，并跳过材料、脱敏、项目 Skill 与异步钩子队列。未设置时保持上述默认行为。该范围只限制领取和中断恢复，不改变已冻结任务输入。

新材料库任务按internal/API/Agent lane加入相应公平队列；legacy任务还检查provider、execution_target和钩子归属。配置保存不代表每个进程已经加载。并发来自 `STORAGE_DIR/.concurrency/agent-slots.sqlite3` 中的持久设置，未保存才回退环境默认Agent2/API8；页面可设置Agent 1–6、API 1–8；范围以 `concurrency.ts` 的常量为准，环境兼容范围另见该文件，变更后按接口的restart_required核对进程。Agent槽位协调同一存储下的进程；API传输槽位见llm-api模块，不宣称跨机器全局限制。内存监控可能暂停新领取，不终止已执行任务。

`steps`是当前状态，`step_attempts`是尝试历史。`waiting`须结合活动尝试、就绪原因和worker归属判断；HTTP202只表示已接受或等待未终结。按原attempt/job/request key恢复，不因超时重新派发。单题与批量资格分别由入口及业务模块复核；批量一题失败不把其余结果改成失败。

钩子采用独立检查点和事件，不恢复通用自动返修链。可选033表缺失不阻断无钩子旧流程；启用钩子、迁移和恢复副作用分别遵守对应接口与授权。

## 读取、日志与维护

首屏列表/状态使用服务端白名单和批量快照；正文、历史及材料版本按需读取。`GET /api/attempts/:id?view=status`不读取结果正文，CLI等待默认使用该视图；完整内容由show/full显式读取。普通文件下载不证明内容质量或平台成功。

共用安全日志入口为 `logging.ts`，默认位于 `<STORAGE_DIR>/logs/<UTC日期>/`。请求通过 `X-Request-ID`、attempt/job/call ID关联。普通JSONL只落盘错误及指定数据库慢查询/连接等待告警；不记录材料、题面、提示词、答案、SQL参数或凭证。Codex私有事件和业务报告不是普通日志。命令和限制见 [诊断脚本](../scripts/diagnostics/README.md)；健康和`/api/monitor`状态不能证明供应商仍在生成。

修改公共契约同时核对前端、CLI、路由、任务输入快照及历史兼容。文档中的配置/迁移/启动命令是参考，授权边界见 [AGENTS.md](../AGENTS.md)。本文件不声明某次数据库、真实模型或外部平台验收已完成；历史证据按其时间和范围单独阅读。

### 空队列探测

worker 对同类队列的并发可用性查询共用一个进行中的探测；空结果最多复用3秒，与原空闲轮询间隔一致。正结果不缓存，实际领取事务、执行并发、公平轮转及过期任务恢复保持独立。此优化不增加并发上限，也不共用已领取任务。
