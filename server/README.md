<!-- 文件职责：说明服务端入口、模块职责、队列数据流与维护约束。 -->
# 服务端与 worker

Bun + Hono + PostgreSQL（pg）的本地工作台后端。`app.ts` 装配 API，业务实现按模块拆分；持久化任务由独立 `worker.ts` 消费，HTTP 等待不决定任务生命周期。API 默认监听 `127.0.0.1:3700`，可通过 `.env` 的 `PORT` 覆盖。

远程闭环：`remote-material-routes.ts` 只在 `MATERIAL_EXECUTION_TARGET=server` 且配置 `REMOTE_MATERIAL_TOKEN` 时注册带令牌接口；材料操作由 `remote-material-operations.ts` 推进，作答接口用固定请求标识将尝试绑定到服务器。材料接收、PDF/DOCX 提取、API 脱敏和模型作答都按 `step_attempts.execution_target` 隔离，本机旧任务默认 `local`。云端专用 `WORKER_MODE=server` 与 `MATERIAL_EXECUTION_TARGET=server` 处理服务器归属的入库、提取、API 脱敏和作答，不运行 Agent 或评分队列；`WORKER_MODE=materials` 继续只处理服务器材料操作，不领取作答；本机默认 `local`。服务器与本机需共享业务数据库，服务器项目来源目录按数据库绝对路径挂载；两地 `.storage` 各自保存管理副本，CLI 按哈希取回本机需要的文件。迁移及部署需要分别核对，源码存在不证明服务已启用。

项目详情 API 返回的题目工作流按 `source_key` 中的题号数字升序排列，避免相同创建时间时由 UUID 决定显示顺序。

`system-step-prompts.ts` 读取／保存数据库中的系统级脱敏、出题、作答和评分提示词；代码默认值用于首次初始化。新项目创建事务将四条系统提示词复制到项目步骤配置，之后系统设置变更不回写现有项目。作答提示词随答案任务输入冻结；项目提示词变更只作用于后续派发。

服务端引用共享契约时使用 `@shared/`（映射到仓库根目录 `shared/`）；同模块及相邻模块继续使用相对路径。

## 材料包多题入口

`project-folders.ts` 按项目 `material_mode` 同步来源目录：旧模式登记题目，新模式登记材料包。`material-package-questions.ts` 从材料包的成功脱敏尝试创建题目私有快照，复制同工作流归属的材料和脱敏产物，记录来源 ID／正文哈希及本项目选中的出题标签；失败回滚数据库并清理新目录。`app.ts` 提供版本列表、建题、标签维护、执行历史分页和显式模式切换；项目列表保留工作流总数，同时分别计数未删除材料包与题目。材料包只派发 1／2／9；派生题目只派发 4–8。上传材料在新模式下登记材料包。旧工作流和模型／评分配置沿用原契约。源码支持不代表数据库已执行 035 与 037 迁移。



`.env.example` 将 `WORKER_MODE` 设为 `local`，用于本机材料接收／提取及 Agent/Codex 队列；`api` 处理本机归属的作答、API脱敏和API评分；专用 `materials` 要求 `MATERIAL_EXECUTION_TARGET=server`，只处理服务器材料队列和组合操作；`server` 要求 `MATERIAL_EXECUTION_TARGET=server`，处理服务器材料任务及服务器归属作答，不启用 Agent 或评分队列；`all` 处理原有全量本机队列（worker 入口未设置时保持 `all` 兼容行为）。API 可通过 `HOST` 配置监听地址，以 `SERVE_WEB=1` 提供构建后的工作台；云端固定服务定义见根目录 `docker-stack.yml`。`GET /api/health` 同时检查数据库连接和当前文字工作流需要的迁移是否已登记；可选的 033 钩子迁移不阻挡旧文字链路就绪。健康检查只核对状态，不执行迁移。

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 创建连接池／应用，在回环地址监听，退出时关闭资源 |
| `app.ts` | 应用中间件与路由装配；步骤执行路由集中注册在 `workflow-execution-routes.ts` |
| `db.ts` | TLS 校验及 channel binding 的连接池 |
| `concurrency.ts` | 校验 Agent／模型 API 并发配置；在共享 STORAGE_DIR 的 SQLite 中保存全局设置并协调 Agent 工作队列与连接测试名额 |
| `migrate.ts` | 按完整文件名登记的显式事务迁移 |
| `worker.ts`、`worker-pool.ts` | 业务消费池与通用并发／轮询／退避／停止信号 |
| `task-signal.ts` | 任务取消状态和异步 AbortSignal 传播 |
| `project-folders.ts` | 目录发现（超限 PDF 由 `materials/pdf-split.ts` 生成管理分片）、步骤投影、前置条件统一判断、分块批量及配置校验 |
| `material-package-questions.ts` | 列成功脱敏版本，从材料包创建独立题目的私有整包快照、来源绑定与失败清理；不执行模型脱敏 |
| `intake.ts`、`intake-jobs.ts`、`intake-jobs.test.ts` | 材料原件接收、目录入库任务及 worker 停止后的待处理状态恢复验证 |
| `rules.ts`、`rule-files.ts`、`rule-currentness.test.ts` | 主项目共享 `materials/` 与 `skill/` 文件管理、期次 `project.json` 读取、引用检查、任务级文件指纹及历史快照校验；采用候选时写入稳定共享目录，`rule-loading.ts` 是已停用的旧规则绑定入口 |
| `attempts.ts`、`attempts.test.ts`、`validation.ts` | 轻量／完整任务读取、有限请求等待、轮询／取消单测与接口输入边界 |
| `workflow-execution-routes.ts`、`step-dispatch.ts` | 单题／批量执行与 attempt 等待 HTTP 契约；统一 ordinal 派发映射，路由不接管队列业务 |
| `external-call.ts` | 外部调用的 `call_id`、上下文和结果日志；不访问数据库、不执行返修逻辑 |
| `generated-data.ts` | 工作流全量重置、文件隔离与失败恢复 |
| `logging.ts` | 结构化事件白名单投影、上下文关联、JSONL 写入／保留，以及保持致命退出语义的同步错误记录 |

## 业务模块

- [材料提取／脱敏](materials/README.md)、[PDF provider](materials/pdf-extraction/README.md)
- [独立 Agent 执行／设置](agent/README.md)、[底层 Codex CLI 适配](codex/README.md)、[项目 skill 生成](skill-generation/README.md)
- [独立大模型 API 调用](llm-api/README.md)：由作答和 API 脱敏复用
- [出题](authoring/README.md)、[模型作答](answer-models/README.md)、[独立评分](scoring/README.md)
- [达标判断](decisions/README.md)、[成果发布](publishing/README.md)、[统计与导出](reporting/README.md)
- [本地监控](monitoring/README.md)

当前 worker：材料接收／提取并发跟随持久化的模型 API 并发设置；作答和 API 评分通过 API worker 通道轮转，API 脱敏由独立消费池处理；skill、Codex 脱敏、出题和 Codex 评分共用 Agent 通道并轮转。API 脱敏任务池并发跟随同一 `llmApi` 配置，脱敏任务内部的分批请求和其他模型调用仍由全局 API 请求槽位共同限流。评分队列按任务冻结的 provider 分流，旧任务缺少 provider 时按 Codex 处理。系统设置可保存安全范围内的 Agent 1–4、API 1–8，写入 API 与 worker 共享的 `STORAGE_DIR/.concurrency/agent-slots.sqlite3`，无须 PostgreSQL 迁移。设置在 API 与 worker 重启后生效；未保存时兼容 `AGENT_CONCURRENCY` 与 `LLM_API_CONCURRENCY` 环境变量（各自范围 1–32）。Agent 槽位记录与配置共用该 SQLite 文件；连接测试与 worker 任务使用同一 Agent 上限，进程异常退出后，下一次领取会清理已退出进程的槽位。当前只支持一个本地 worker，模型 API 上限是该 worker 内所有 API 队列的总上限，不是每供应商／每队列各自上限。普通工作流由用户派发。

API／Agent 通道每轮先查询是否存在等待任务或超时未心跳的运行任务；确定为空时跳过各队列的领取事务。命中后仍由原队列按既有锁、顺序和恢复条件领取；空队列轮询间隔保持 3 秒。此处减少空转数据库往返，不改变模型调用。

`attempts.ts` 的 HTTP 等待每秒查询一次（截止时间不足1秒时只等待剩余时间），取消及时唤醒且不取消持久任务。`GET /api/attempts/:id?view=status` 不查询或返回结果正文，只返回任务元信息；省略视图或 `view=full` 兼容完整结果读取。CLI 默认等待使用状态视图，`attempt show` 和 `attempt wait --full` 读取全文。此处减少状态观察开销，不修改 Codex 工具、权限、会话或队列并发。

项目步骤汇总、逐题记录和批量派发共用 `workflowStepReadiness()` 判断：当前步骤待执行或失败、没有活动尝试、步骤启用，且最近一个启用的可见前置步骤成功；未达标后可按普通步骤重新派发出题、模型作答或独立评分，重跑上游会清除并使后续结果失效。发布还要求第七步结果明确为 `accepted`，未达标结果不能进入发布。达标汇总将判定结果拆分为达标、未达标和隔离，不把未达标的判定计作达标。达标项目的模型身份来自项目模型集合；若配置 ordinal 7 的 `aggregation`，程序按该项目策略计算均分并在当前结果投影中保留，否则沿用逐模型百分制上限。入库将 PDF/DOCX 提取状态与活动尝试一并计算，评分允许对已全部终结且至少一个成功的部分模型答案派发。历史 ordinal 2、3、10 不作为可见前置条件。批量按配置分块处理所有项目题目，单题结果独立返回；第七步达标判断继续在评分完成后自动触发，也可用项目批量入口重算符合条件的题目，仍只执行程序分数判断、不调用模型。

## 数据与维护约束

以 PostgreSQL 中的附件与任务状态为依据：脱敏读取数据库中的原始提取文本；出题、作答和评分读取数据库中的脱敏附件。出题还读取本次步骤设置、单题可选出题方向及项目本地 skill；`PATCH /api/workflows/:id/authoring-direction` 保存方向、场景及角色视角，支持部分更新，未传字段保持原值；空值不增加对应指令，变更仅使本题出题及下游当前结果失效。方向最多4000字符，场景及角色各180字符。评分 Agent 与评分 API 都只接收同版题面、rubric、匿名答案、数据库脱敏附件和评分步骤提示词，不接收作答思路、标准答案、项目 skill、目标分数或作答模型身份；思路与标答仅用于内部完整性和版本绑定校验。任务记录输入文件指纹、评分方式及模型设置，结果提交前再次校验；历史不能随当前界面顺序重新编号。旧编号规则绑定只用于历史尝试兼容，不用于新任务。

当前已有各阶段入口，不等于真实卷宗闭环验收。归档步骤校验达标依据后优先执行主项目 `scripts/delivery.ts`（兼容旧根目录入口），缺失时执行内置空函数；成功归档后自动导出脱敏 DOCX 和单题数据 Excel，DOCX 可从题目页下载或重试，Excel 有独立下载接口。Work 归档页面要求输入已确认的 Harbor task_id/org；该信息只参与本次归档和去重，不由出题器猜造。项目级完整 Excel 导出仍单独触发。Work 项目脚本已接入 AI 模拟专家成果、检索轨迹、Siriser 内容稿五件套及 Harbor 单题六件套预备包；Harbor 预备包仍标记不可提交，正式规范验收未完成。单题 Excel 不替代这些专用交付物。迁移应用、进程状态、认证／额度、真实模型行为、材料准确性和业务结果必须分别验证。操作限制见 [AGENTS.md](../AGENTS.md)，整体关系见 [架构设计](../docs/architecture.md)。

工作流重置只在没有排队或运行中任务时执行：事务删除该题的材料、尝试、产物和步骤结果，并清除该题的存储管理目录及提取缓存。项目来源目录和 `source_manifest` 保留，供再次入库；单题导出及其文件删除，多题导出标记过期以保留其他题目的数据。

## 全系统后端日志

`logging.ts` 是整个后端共用的安全事件记录器，覆盖 API、数据库访问、worker、业务步骤、外部调用和文件边界，不是某个服务的专属功能。普通 JSONL 只保存 `error` 级失败事件；成功、进度、性能告警和正常业务状态只供调用点使用，不落盘。出题、评分、skill 生成及 Codex 脱敏失败会附带安全的 `failure_phase`，便于区分输入校验、Agent 执行、结果校验和结果保存。JSONL 写入 `<STORAGE_DIR>/logs/<UTC日期>/`，每行带 `build_id`；部署可设置 `APP_BUILD_ID`，本机默认标记为 `local`。API 每个非健康请求生成 `request_id` 并通过 `X-Request-ID` 返回；无任务的管理操作另有关联 `operation_id`。服务入口监视未捕获异常；致命异常同步写入安全事件，未处理 Promise 拒绝记录后以非零状态退出。日志字段按白名单投影，不记录 SQL 参数、材料正文、提示词、答案、凭证或原始模型错误。Codex 失败元数据与脱敏 attempt/step result 中的错误摘要只保留安全类别、原因码、调用 ID、重试标记和发生时间。Codex 的 `events.jsonl` 仍是受限私有产物，不复制到普通日志。

查询本机日志可运行 `bun scripts/diagnostics/read-logs.ts --attempt-id <id>`，也支持按 `--service`、`--component`、`--operation`、`--request-id`、`--operation-id`、`--project-id`、`--workflow-id`、`--skill-attempt-id`、`--call-id`、`--level`、`--from`、`--to` 过滤。脚本只读普通日志目录，并限制文件数、扫描字节和返回条数；汇总中的 `incomplete_tail_lines` 指出缺少换行结束符的末尾记录。`GET /api/monitor` 的 `logging` 字段提供写入健康状态、最近成功时间及丢弃计数。管理 API 已通过合成请求验证 request ID 回传及 project/operation 日志关联。

当前已接 API/worker 入口、数据库连接/查询/事务、项目文件与步骤设置、Codex 与脱敏优先链，以及主要业务和文件边界；旧规则绑定入口已停用。全系统逐入口验收仍未完成。OCR provider 和提取任务专项按用户要求跳过。设计进度和逐项缺口见[后端日志计划](../docs/plans/2026-10-09-backend-logging-design.md)。

`llm-api/` 与 `agent/` 并列：作答和 API 脱敏调用前者，本地 Codex 任务调用后者；模型队列和结果提交由业务模块管理。脱敏可在步骤设置中选择两种执行方式。

`GET /api/materials/:id/download` 返回附件下载。附件全文弹窗通过 fetch 读取 PDF 响应并创建临时 Blob URL，在浏览器内置查看器中预览；预览不改变下载接口的 `Content-Disposition`。

2026-10-09 工作流定位补充：统一错误分类读取 `http_status` 并保留安全 `reason_code`；API 区分 JSON 解析和业务校验错误；脱敏校验补附件、页码和数量明细；PDF 提取任务补 workflow/attempt 及附件调用事件。本轮仅源码和静态检查，不代表运行进程已加载或 1–8 步故障场景全部验收，见 [定位核对](../docs/evidence/2026-10-09-workflow-log-audit.md)。


## 2026-10-11 按需读取调整

项目、工作流详情取消自动轮询和费用统计。题目与材料包表每页批量读取轻量状态，步骤表格分块读取；业务详情保留当前题目、各模型作答和评分，移除通用输入／配置／输出弹窗。材料包工作流详情另返回其未删除派生题目的摘要列表，详情页按页批量读取各题状态；派生题目详情返回来源材料包标题。通用工作流详情历史只返回有限摘要；`/api/workflows/:id/steps/:ordinal/attempts` 分页返回安全执行元信息，不含冻结输入及私有正文。更新来自页面打开、操作后刷新或手动刷新。任务监控和活动 skill 生成保留前台 10 秒刷新。

`workflow-view.ts` 负责列表批量状态和详情字段投影；`task-signal.ts` 按连接池批量检查取消，普通步骤与项目 skill 分组查询、单组失败不影响另一组，并为状态 SQL 设置 2 秒 PostgreSQL `statement_timeout`；取消日志不继承单个任务的关联 ID。worker 空队列保持配置的约 3 秒发现间隔；Agent 内部的 skill、Codex 脱敏、出题和评分队列成功消费后轮转。SIGINT／SIGTERM 阻止新领取，Agent 槽位等待和提取调用接收停止信号；入库在开始原件写入前可退回等待，已进入材料接收事务的操作安全收尾。费用、价格、产量统计接口已删除；reporting 仅负责按需成果导出。

## 路径基准

`paths.ts` 从自身位置确定仓库根目录；`resolveRepositoryPath()` 保留绝对路径，相对路径按仓库解析；`storageDirectory()` 为入口与 PDF 诊断统一存储位置。API 的 storageRoot、目录输入和基础模板采用相同基准。目录输入仍经 realpath 校验并保存绝对路径，历史任务指纹与凭证配置不变。
## 项目评测契约兼容改造（实施中）

阶段钩子的当前实现：

| 文件 | 职责 |
| --- | --- |
| `workflow-hooks.ts` | 冻结入口及声明依赖，复制到临时目录，以 Bun 子进程交换有界 JSON；只接收附加 notes/data，不覆盖主产物。脚本为受信任项目代码，不是 OS 沙箱。 |
| `workflow-hook-jobs.ts` | 三个阶段的同步前后钩子、主操作持久检查点、异步动作登记；无钩子时不访问新表。后置异步动作在主结果提交事务内登记。 |
| `workflow-hook-worker.ts` | local/all worker 领取异步脚本任务，保留独立结果；失效输入取消、失联幂等动作恢复、未知副作用待核。API worker 不领取。未迁移时只探测表是否存在。 |

`033_workflow_hooks.sql` 尚未实际应用。带钩子的作答／API评分主任务由 local/all worker 执行，api worker 只处理无本地脚本任务，领取与中断恢复使用同一筛选；local worker 在已有 API 并发配置内处理这部分主任务。API 并发仍为单 worker 限制，不宣称跨机器全局限流。

`workflow-hook-routes.ts` 提供 `GET /api/workflows/:id/hooks`（只返回有限执行结果，不返回私有脚本／检查点正文）、`POST /api/attempts/:id/resume-hooks`（恢复原失败尝试，复用完整且指纹有效的主检查点）、`POST /api/hooks/:id/retry`（单独重试异步附加任务）。重试参数为 `{acknowledge_side_effects?:boolean}`；非幂等副作用待核时必须显式确认。原错误保留在 history 中，未知主调用状态不续跑。普通“重新执行步骤”仍是新尝试语义，不等于检查点续跑。

受控模型请求、附加输入／产物索引和界面仍在实施，真实 PostgreSQL／服务验收未完成；不能据此宣称完整钩子流程已验收。

显式 `model_report_v1` 项目从评分设置冻结本题规则，完整传递 Rubric rule 与 metadata；评分依冻结政策可收到校准标答，始终不收到作答思路。程序收集模型原始分、报告比较指标和独立否决，不重算成绩；达标使用报告指标，缺失时等待。新旧模式各自保留解析和绑定约束。Excel 已适配，新页面、可执行钩子及线上启用仍在实施。未特别说明的旧正分／排除标答契约适用于默认 legacy 模式。

流程扩展局部保存：`PUT /api/projects/:id/steps/:ordinal/workflow`（ordinal 4/5/6），请求 `{workflow:配置或null}`；只合并／移除该字段，不覆盖已有模型、提示词或作答策略。前置同步脚本可显式声明 `input_purpose`，返回相应用途的 `additions:[{purpose,text}]`，用于出题／评分补充说明并记录在检查点；作答不允许附加输入。脚本可返回 `artifacts:[{name,text}]`，正文与摘要保存在钩子记录，不替换或发布主成果。无新增返回字段时保持旧空结果形状。

钩子可选 `model_request:{config:完整非敏感API配置,prompt:固定说明}`，脚本输出 `model_request:true` 仅触发该声明；宿主只发送阶段白名单 input/output，不接受脚本任意消息。复核文本、usage、模型配置与 call_id 存于 model_result；声明 input_purpose 的同步前置复核可附加给出题／评分。第一版额外复核复用 llm-api，不嵌套调用主阶段 Agent；普通 API 与钩子 API 共用本机槽位。模型请求无供应商幂等保证，配置须 idempotent=false，未知状态不自动重复收费请求。

阶段队列恢复失联主尝试时，在原恢复事务及锁内调用 recoverInterruptedStageHooks：旧无钩子任务不查新表；成功检查点及意见保留，运行中同步记录／主检查点转 needs_review，并给原尝试保存 project_hook_failed 标识。续跑读取全部当前同步／检查点记录，因此主操作成功后、后置钩子尚未登记的中断也能继续；未知主检查点仍拒绝重复调用模型。

健康检查对结构性迁移保持未完成即503；033是可选钩子表，空钩子文字流程不以它作为就绪前置。钩子记录接口单独报告表是否可用；启用钩子前仍需人工应用033，不自动迁移。

workflow-view.ts 的完整题目投影保留 work_legal_v1 的独立内容字段；轻量状态接口继续省略正文。具体契约与验证边界见 authoring/README.md。

文字作答支持跨项目成果清单适配：`answer-models/input.ts`派生并冻结公开清单的文字呈现方式；队列实际发送该约定，评分回读同版约定并保持原Rubric。无清单的旧题不变，Work草稿与非文字输入不放开。该能力是文字成果测试，不代表文件、检索或工具执行已验收；详见answer-models与scoring模块README。
