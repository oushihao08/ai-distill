<!-- 文件职责：记录后端结构化日志的设计目标、格式、保留策略及实施方案。 -->
# 全系统后端日志设计

日期：2026-10-09。状态：部分实施；全系统覆盖与运行验收尚未完成。

## 目标与边界

这是整个后端的公共日志能力，覆盖所有 API、数据库访问、worker 调度、业务步骤、外部服务调用、文件操作和服务生命周期。Codex 脱敏是优先接入与排查的场景，不是日志系统的服务边界。没有 attempt_id 的项目管理、设置、规则编辑、下载、健康检查等操作，也必须通过 request_id 或 operation_id 关联。

既能按一次任务回答什么时候入队和领取、调用哪个模型、何时触发超时、进程是否实际退出、状态是否写回，也能按服务和时间查询系统异常、慢请求、数据库连接故障、文件失败与启动关闭情况。不同模块共用格式、错误分类、关联方法、查询与保留策略。

实施不改业务调度、并发、模型选择、超时值和返修规则；日志不作为自动重试依据。沿用用户要求，不改动或运行 OCR，不重新处理真实卷宗。日志设计不能代替脱敏质量或真实业务闭环验收。

## 当前实施状态

| 范围 | 当前状态 | 证据／剩余项 |
| --- | --- | --- |
| 公共 JSONL writer | 已实现字段白名单、build_id/上下文、10 MiB 分段、7 天/200 MiB 清理、有限队列、有序关闭和健康状态；配置 logger 关闭后解除全局绑定，写盘恢复后追加恢复事件；致命异常提供同步安全写入；跨进程保留清理使用排他锁协调 | `server/logging.ts`；隐私、异步上下文、build_id、轮转/保留、写盘失败与恢复、缓冲溢出优先级、关闭、两个 Bun 子进程并发写入，以及并发保留清理均有测试；锁超时回收和多机共享目录不在本地单机设计范围 |
| API、进程与数据库 | 已接 API 请求 ID/响应头、按路由生成 operation 并关联 project/workflow ID、真实 HTTP 失败状态、管理写操作成功后的安全变更事件、服务及迁移入口生命周期、worker 调度错误、连接失败/恢复、查询失败与慢查询、事务开始/提交/回滚及 commit/rollback 命令失败时的结果未知；API/worker/migration 入口记录未捕获异常及未处理拒绝；monitor 返回 logger 健康字段并记录派发暂停/恢复和采样恢复 | `server/app.ts`、`index.ts`、`migrate.ts`、`worker.ts`、`db.ts`、`worker-pool.ts`；管理事件只记录操作类别、目标 ID 和字段名，不记录正文；Agent 系统／项目设置 API 的请求关联与变更日志、假客户端事务结果未知有合成测试；尚未真实 PostgreSQL／本机服务运行态验收 |
| Codex／脱敏 | 已接调用认证、超时实际触发、终止请求、exit/close、Codex 线程/轮次、结果解析/校验，以及脱敏任务领取、输入规模、心跳失败/恢复、状态提交和过期回收；调用预算包装器的 `call_id` 贯穿出题、独立审查、评分和脱敏的 Agent/Codex 子进程；Codex 错误保留安全调用 ID、原因码、重试标记与发生时间，脱敏失败摘要写入现有 attempt/step result 并保留原中文提示 | `server/codex/client.ts`、`materials/redaction-jobs.ts`、`materials/redaction.ts`、`decisions/revision-calls.ts`；受控超时、非零退出、工作区准备失败、缺失/非法 JSON/未完成轮次、错误摘要持久化、调用 ID 穿透返修预算包装器、材料数/页数/空正文校验，以及脱敏心跳失败/恢复和过期回收均有合成测试；本次未运行 OCR、真实调用或业务任务 |
| 非 OCR 业务与文件 | 已接入入库、规则绑定、作答、出题、独立审查、评分、skill、达标、返修、发布、导出、规则文件、工作流重置及材料/产物下载的主要任务与文件边界；队列心跳/回收、任务取消轮询、重置/迁移回滚失败和监控快照读失败/恢复均有结构化事件 | 隐藏的 ordinal 3 规则绑定有开始、复用、成功及失败事件；返修链启动/恢复新增阶段结果事件；规则文件读取失败新增安全事件；独立审核 worker 新增领取、开始、质量检查结果、状态写回及带 attempt 上下文的失败事件；嵌入执行器内部的临时快照读写统一由任务阶段关联；关键日志路径有合成或单元测试，真实业务任务未运行 |
| 查询工具 | 已实现 service/component/operation、request/project/workflow/attempt/call ID、等级和时间过滤，扫描/输出上限、字段再净化及尾部未完成 JSONL 记录计数 | 合成 JSONL 查询可按 attempt ID 读回；敏感字段剔除有单测；本轮用合成断尾文件验证 `incomplete_tail_lines` 从缺失（失败）变为正确计数；Codex 项目设置 API 的 request_id、route operation、project_id 和 X-Request-ID 端到端通过；尚未用服务运行态日志验收 |
| OCR | 明确跳过，没有改动 OCR provider/提取任务逻辑，也没有运行 OCR | 通用 API/数据库/worker 层记录可能覆盖系统级错误；不作为 OCR 专项接入或验收 |

此前定向回归运行 intake、作答/出题/评分/skill 队列、worker monitor、logger、任务取消、工作流重置和数据库假 client 共 10 个测试文件，结果为 **85 项通过、0 项失败**；Codex 设置 API 的 request_id、X-Request-ID、路由模板和结束状态关联测试 **1 项通过**。本轮 `server/logging.test.ts` 与 `server/codex/client.test.ts` 最近一次联合运行结果为 **26 项通过、0 项失败**：其中包含同一日志目录下两个子进程并发写入 50 条完整事件且 instance_id/event_id 不冲突；分别注入未捕获异常与未处理 Promise 拒绝，日志同步落盘并确认进程仍以非零码退出；Codex 覆盖受控超时、非零退出、工作区准备失败及统一 call_id。随后 Codex 客户端 14 项全量测试再次运行通过；缺失结果、非法 JSON、未完成轮次、validator 原因码传播的定向测试通过；材料数不匹配、页数不匹配和空正文的脱敏 validator 测试 **3 项通过**，只调用脱敏结构校验，未执行 OCR。本轮另运行 Codex 设置 API 关联测试 **1 项通过**、数据库假 client 测试 **3 项通过**、`git diff --check` 通过。此前较宽的 15 文件回归有 111 项通过、2 项发布 fixture 失败（脱敏附件与出题快照不一致，发生在发布前置校验）；API/DB/logger 单独回归有 14 项通过、5 项 API 上传 fixture 返回 404，尚未用干净基线复核，不应和本轮定向结果混算。此前筛选的 `tsc --noEmit` 在 `server/scoring/jobs.ts` 现有 `project_rules.files` 解构处报告 3 个隐式 `any`；本轮 `tsc` 命令不可用（`command not found`），因此没有新的类型检查结果。假 client 数据库事件、API 关联、下载事件和敏感字段剔除通过合成验证；真实 PostgreSQL 连接故障、慢查询、本机服务运行态及跨进程保留清理仍未验收，因此不能称为全系统完成。

本轮为 API 管理变更映射补回归后，先确认系统／项目设置缺少 `management.changed`，补入 Agent 与旧 Codex 路径映射后两项定向 API 测试通过；logger 的 `changed_fields: none` 白名单测试通过。测试期间发现 Hono 4.13 的 `.get/.put/.post/.delete` 不把路径数组解释为多个路由，设置别名曾导致路由 500；已改用 `app.on(method, paths, handler)`，并补齐 Agent 配置 barrel 中实际被 worker/业务模块引用的 `mergeCodexDefaults` 导出。完整 `app.test.ts` 与 `logging.test.ts` 联合运行结果 **21 项通过、5 项失败**；5 项均为上传测试 fake pool 未模拟 PDF 入库后 `enqueueExtraction` 所需的 workflow 查询，返回“工作流不存在”，与本次日志行为无关。`server/logging.test.ts` 与 `server/codex/client.test.ts` 当前联合结果 **29 项通过、0 项失败**；包括 build_id、并发写入/清理、缓冲优先级及 Codex 超时/退出/结果校验。两条系统／项目 Agent 配置 API 定向测试 **2 项通过**；数据库提交结果未知故障注入 **1 项通过**。日志查询器尾部残行计数先通过合成输入验证缺失，再实现 `incomplete_tail_lines` 并验证通过。`git diff --check` 通过。全系统其他组件和真实运行环境仍须按上表验收。

本次继续修正 Codex 总截止时间先于子进程局部计时器触发时被误记为取消的问题：超时事件现在由总截止计时器记录，终止请求归类为 timeout，完成事件仍需等到子进程实际 close。Codex 调用失败向上游保留安全元数据；脱敏失败将仅含 `kind`、`reason_code`、`call_id`（可用时）、`retryable`、`occurred_at` 的摘要合并进 attempt 与 step 的现有 result JSON，原始异常文本不会持久化，原中文错误提示保持不变。`server/logging.test.ts` 与 `server/codex/client.test.ts` 联合 **33 项通过、0 项失败，102 项断言**；覆盖摘要持久化与私密异常文本排除、Codex 调用 ID/原因码传递、总超时分类，以及既有 logger/Codex 情景。`git diff --check` 通过。真实 Codex、数据库和服务运行态仍未验证。

随后把 `runRevisionCall()` 的同一 `call_id` 传入出题、独立审查、评分及脱敏的 Agent 调用，确保预算事件、Codex 登录／进程日志和失败摘要可按一个调用 ID 查询；作答供应商自身没有第二套调用 ID，继续使用外层预算调用上下文。新增普通任务调用 ID 传递断言，并联合运行 logger、Codex、返修调用、出题队列和评分队列 **62 项通过、0 项失败，199 项断言**。OCR/材料提取外部调用仍按用户要求不改动。

补充运行 Agent、出题执行器和评分执行器测试：**15 项通过、0 项失败，56 项断言**，确认 call_id 能穿过 Agent 入口，既有作者/独立审查隔离和匿名评分行为保持通过。最新 `git diff --check` 通过。全系统其余范围和真实服务/数据库验收仍未完成。

继续盘点非可见业务步骤时发现 ordinal 3 规则绑定此前只有 API/数据库层日志，没有步骤级结果事件。已为规则绑定补充开始、复用、完成和失败日志，并用现有 fixture 验证关联字段。`server/rule-loading.test.ts`、`server/decisions/revision-calls.test.ts` 和 `server/agent/runner.test.ts` **12 项通过、0 项失败，49 项断言**；真实运行态仍未验证。

本次按“共用日志模块并接入关键位置”继续补齐返修链启动/恢复的开始、复用、完成和失败事件，以及规则文件读取失败事件；日志关联工作流、项目和返修链，只记录安全错误分类，不写文件路径或正文。`server/decisions/revision-jobs.test.ts` 与 `server/rule-files.test.ts` **15 项通过、0 项失败，46 项断言**；`git diff --check` 通过。仍未进行真实服务、PostgreSQL 或业务运行验收，OCR 继续跳过。

为本轮用户准备的脱敏、出题、独立审核测试补齐审核 worker 的领取/开始、质量检查结果、状态写回、失败和过期回收事件；失败事件会保留审核 attempt、workflow、project 关联。`server/authoring/jobs.test.ts` 的定向失败路径测试 **1 项通过**。本机现有日志只有 API 记录，reader 统计 `malformed_lines=0`、`incomplete_tail_lines=0`；错误级记录为 0，发现数据库连接池获取耗时超过 250ms 的 warning。尚无这三步的新运行记录，需等业务测试运行后按 attempt_id/call_id 复核。

## 全系统覆盖清单

| 范围 | 必须记录 | 关联依据 |
| --- | --- | --- |
| 全部 HTTP API | 请求开始/结束、状态、耗时、输入校验/来源拒绝、未匹配路由与异常 | request_id、路由模板 |
| 项目、设置、模型目录与规则管理 | 操作类别、目标 ID、成功/失败、版本或配置变更字段名；不记录字段正文和凭证 | request_id、operation_id、project_id；成功变更由 API 统一中间件生成 `management.changed` |
| 数据库 | 连接失败/恢复、连接池等待、慢查询、查询失败、事务提交/回滚与提交结果未知 | 上下文 ID、固定 query_name/transaction_name、安全数据库错误码；不记录 SQL 参数或原始错误 |
| worker 与队列 | 入队/复用、领取、开始、结束、心跳失败/恢复、过期回收、派发暂停/恢复及调度异常 | instance_id、attempt_id 或 skill_attempt_id |
| 业务步骤 | 入库、脱敏、规则绑定、skill、出题、质检、作答、评分、达标、返修、发布、导出的阶段与结果 | project_id、workflow_id、版本、attempt_id、operation_id |
| 外部模型与子进程 | 认证检查、调用、进展、超时、取消、退出、安全错误、结果校验、已知 usage | call_id、provider、model、child_pid、session_id |
| 文件与产物 | 保存、读取、指纹校验、发布、下载、清理失败；成功以产物发布等必要边界记录，避免逐次读取刷屏 | artifact_id、operation_id、文件类别；不记录敏感文件名/路径或正文 |
| 服务运行与监控 | 启动/关闭、版本标识、未捕获异常/拒绝、监控采样失败/恢复、日志写入退化及恢复 | service、instance_id、pid |

OCR 遵循同一契约，但因用户明确要求跳过，当前不修改、不运行、不验收 OCR 接线；将其列为明确的覆盖例外，不能据此声称所有模块均已接入。全系统覆盖不要求记录每条成功 SQL、每个轮询或每次文件读取；应记录必要边界、慢操作和异常，控制日志量。

## 初始问题与当前判断边界

- 初始检查发现 API/worker 多数只写 console；当前 API 请求、worker 调度、数据库和服务生命周期已有统一结构化事件与关联字段，不能再用初始观察代表当前状态。
- Codex 初始调用链没有区分计时器触发、kill、实际 exit/close 与结果校验；当前 `server/codex/client.ts` 对这些边界分别记录事件，受控子进程合成测试通过，真实 Codex 仍未调用。
- 脱敏任务目前会记录输入规模、调用结果、心跳失败/恢复、状态写回和过期回收；过期回收事件有合成测试。重跑真实业务、验证实际数据库状态与脱敏效果仍未进行，不能从日志接入本身推断脱敏成功。
- `.worker-monitor.json` 仍是可覆盖的运行快照，不是事件历史；快照采样、写入、读取失败及恢复现在都会写结构化日志，读取不存在文件仍视为正常未启动状态。结构化日志本身也会在写盘恢复后记录恢复事件。
- 任务取消查询和工作流重置/迁移事务回滚失败现已补结构化事件；材料提取 worker 的局部错误仍属用户要求跳过的 OCR/提取链，本轮不接入、不运行。
- 国内模型已有安全错误分类，见 `server/answer-models/provider.ts`、`qwen.ts`，日志复用这些分类，不再另建供应商错误规则。

文件修改时间只能证明文件最后被修改，不能充当每个事件的发生时间。等待时长也不能直接当作模型推理时长。

## 方案选择

| 方案 | 成本与取舍 | 结论 |
| --- | --- | --- |
| 本地结构化 JSONL + 现有数据库任务摘要 | 与当前本地 API/worker 部署一致；数据库异常时仍能留痕；需要有限的轮转和写盘状态管理 | 首版采用 |
| 所有事件写入 PostgreSQL | 查询方便，但增加连接与写入压力；数据库故障时日志本身也不可用 | 不采用为主日志存储 |
| 独立日志平台 | 适合多服务器统一检索，当前需增加服务和维护 | 当前不引入 |

新增一个小型 `server/logging.ts`，使用现有运行时内置能力，不新增依赖或修改 package.json。只提供安全事件写入、上下文关联和有限的文件管理，不搭建通用日志平台。

## 存储、关联与字段

建议路径：`<STORAGE_DIR>/logs/<UTC日期>/<api或worker>-<instance_id>-<分段序号>.jsonl`。API 与 worker 分文件；重启生成新的 instance_id，不只依赖可能复用的 PID。

每行是一个完整 JSON 对象；统一记录 UTC 时间和 `build_id`（`APP_BUILD_ID`，本机默认 `local`）。默认等级为 info，warn/error 全量记录；高频成功心跳采用限频记录，写入失败与恢复立即记录。日志事件自身发生时间与写盘时间分开记录，避免把写入延迟算成执行时间。

| 字段 | 用途 |
| --- | --- |
| schema_version、event_id、seq | 固定首版格式、去重及进程内顺序；不声称跨进程全局排序 |
| occurred_at、written_at、level、event、service | 事件时间、落盘时间、类别和来源 |
| instance_id、pid | 识别 API/worker 本次运行 |
| request_id | 每个 HTTP 请求由后端生成，响应返回 X-Request-ID；不信任客户端随意传入的内容 |
| operation_id、component | 无任务的管理/文件/导出操作身份及所属模块；不可用时不伪造 attempt_id |
| project_id、workflow_id、attempt_id、input_revision、ordinal | 关联项目、题目、尝试及材料版本；项目 skill 使用 skill_attempt_id |
| call_id、operation、provider、model、reasoning_effort | 区分同一尝试中的登录检查、出题、质检、评分等多个调用 |
| child_pid、session_id、timeout_ms | 关联子进程、Codex 会话及实际使用的调用超时值 |
| elapsed_ms、wall_elapsed_ms、exit_code、signal | 单调计时耗时、墙钟时间差、进程退出证据 |
| error_kind、reason_code、retryable、http_status | 稳定安全错误类别；未知原因保持 unknown |
| material_count、page_count、input_bytes、output_bytes、token_usage | 输入规模、输出规模和已知 token 用量；无完成事件时不推测 usage |

字段按事件白名单选择，不允许任意对象、Error 或请求/响应对象直接传给 logger。model 等字符串也限定来源、长度与格式。Codex token 用量仅用于诊断，不能换算为 GPT 套餐费用。

请求日志记录路由模板，不记录完整 URL/query。入队事件同时保存 request_id 和 attempt_id，worker 用 attempt_id 接续，首版无需新增数据库关联列。通过异步上下文绑定请求/任务，避免改动所有公共 provider 接口；并发上下文隔离必须验证。

## 必须记录的生命周期

### HTTP 与任务

- HTTP：`request.started` → `request.finished` 或 `request.failed`，包含方法、路由模板、状态码和耗时；轮询/健康检查成功日志限频，失败保留。
- 任务：`attempt.enqueued`、`attempt.reused`、`attempt.claimed`、`attempt.started`，区分排队时间与执行时间。
- 心跳：`heartbeat.write_failed`、`heartbeat.recovered`；成功记录按尝试最多每分钟一次，失败限频且保留累计次数与最后成功时间。不改变现有心跳频率。
- 状态：`state_update.started` → `state_update.committed` / `state_update.failed` / `state_update.unchanged`。事务确实提交后才记录 committed，更新零行应附安全原因，不伪装为成功。
- 回收：`attempt.recovered_interrupted`，记录最后心跳、阈值、负责回收的 instance_id；回收动作和已知原始错误分别保留。

### Codex 与供应商调用

`call.started` → `auth.checked` → `process.spawned` → `codex.thread_started` → `codex.turn_started`。

随后记录已收到的安全事件类型及有限进展计数；不要把 turn.started 当作模型正在有效推理。普通进展限频，完成与错误全量记录。

结束链路需要区分：

1. **正常返回**：`codex.turn_completed` → `process.exited` → `process.closed` → `result.parsed` → `result.validated` → 状态提交。
2. **超时**：`timeout.fired` → `process.kill_requested` / `process.kill_failed` → 实际 exit/close → `call.failed` → 状态提交。
3. **主动取消**：`cancel.requested`，明确来自服务关闭、任务失效等可证明的来源；来源未知保持 unknown。
4. **无效输出**：区分 result_missing、invalid_json、material_count_mismatch、page_count_mismatch、empty_text、incomplete_turn 等实际校验原因，只记录数量或字段类别。
5. **供应商失败**：复用现有 authentication、quota、rate_limit、network、timeout、provider、configuration、cancelled、invalid_response 分类以及已验证的请求 ID。

timeout.fired 的时间与 elapsed_ms 在计时器回调内采集，不能等 close 时才记录。发送 kill 请求不等于进程已退出；仅收到实际退出事件才标为 exited。异常离开时如果缺少进程退出证据，记录为未知。

记录 timer_lateness_ms，比较调用预期截止时间与回调实际时间。墙钟与单调计时差异仅是时钟/挂起排查线索，不能单凭差异证明机器睡眠或某种系统故障。

日志接入只记录这些边界。修改硬超时返回、进程清理或超时数值，需作为执行器修复单独验证，不能夹带在日志接入里。

## 错误、敏感信息与持久化可靠性

- 日志不保存密钥、Authorization、数据库 URL、代理凭证、完整环境、命令参数、材料正文、姓名/电话号码、提示词、题面、答案、评分正文、模型思考文本或原始供应商错误。
- 现有 Codex 原始事件作为受限诊断产物保留，不复制到普通日志，不提供普通下载接口；普通日志只投影事件类型、计数、受限 ID 和安全原因。
- Codex 增加稳定的安全错误类别；不能按任意原始文本直接展示错误。供应商错误沿用现有安全契约。
- 数据库保留状态及兼容的中文提示，在既有 result JSON 中合并安全 error 摘要：kind、reason_code、call_id、retryable、发生时间。保留已有 result 字段，不改成功结果结构；UI 暂时继续使用现有提示。
- 区分原始调用失败与数据库写回失败。写回异常时文件日志仍须能显示 call.failed 和 state_update.failed；未知提交结果必须明确标注，不能凭日志宣称数据库失败或成功。
- 日志目录 0700、文件 0600，放在已忽略的 .storage 内。当前运行默认值为单文件 10 MiB、保留 7 天、普通日志总量 200 MiB。
- 单进程串行写入、有限缓冲；logger 自身不得无限占内存。缓冲溢出时丢弃低优先级的排队事件以保留更高优先级事件，记录 dropped_count；关键事件也无法保存时必须标为 degraded，不保证零丢失。跨进程保留清理通过本机排他锁协调。
- 写盘失败通过安全控制台信息和现有 monitor 返回 logging 状态、最近成功写入时间、drop 计数及固定错误类别；不能静默吞掉。不得把 logger 写盘失败变成重跑业务任务的理由。
- 有序关闭时排空缓冲并关闭文件，设置有限等待。突然断电、SIGKILL 可能丢失未落盘事件；查询工具识别尾部残行并报告。首版不宣称具备审计级零丢失保证。
- 轮转清理只处理 logger 自己的普通日志文件，不删除原件、产物、私有 Codex 事件或活动日志；清理失败可见，不清理业务存储来腾空间。

## 接入位置与职责

| 文件/模块 | 负责的改动 |
| --- | --- |
| `server/logging.ts`（新增） | 事件字段投影、上下文、有限写入、轮转、关闭和健康状态 |
| `server/index.ts`、`server/app.ts` | API 运行身份、请求 ID、请求结束/异常及日志关闭 |
| `server/db.ts` 及事务调用位置 | 连接/连接池诊断、固定查询名称、慢查询和事务结果；不依靠日志推断提交成功 |
| `server/worker.ts`、`server/worker-pool.ts` | worker 运行身份、调度异常和任务上下文；保留既有调度逻辑 |
| `server/codex/client.ts` | 调用身份、计时器、取消、spawn/exit/close、解析/校验与安全错误分类 |
| `server/materials/redaction-jobs.ts`、`redaction.ts` | 首条完整诊断链：输入规模、校验原因、心跳、状态提交和过期回收 |
| 出题/评分/skill、作答/返修/发布/导出模块 | 复用相同事件契约，各自记录已有业务阶段，不改供应商接口或业务结果格式 |
| `server/monitoring/worker-monitor.ts`、monitor API | 返回有限 logging 健康字段，保持既有内存派发策略 |
| `scripts/diagnostics/read-logs.ts`（新增） | 按 service/component/operation、request/workflow/attempt/call ID、等级和时间读取安全时间线；限制扫描量和返回条数 |

首版不增加日志后台页面或任意文件读取 API。查询脚本只读取普通日志目录，不能访问私有事件及材料，不执行模型调用。数据库任务历史继续是业务状态来源，日志是诊断证据。

## 实施任务清单

1. **统一记录基础**：完成事件类型/字段、writer、轮转/保留/退化处理、API 与 worker 的运行身份和请求上下文。交付：按 request_id 可查一条完整请求，写盘异常可见。
2. **优先打通脱敏与 Codex**：记录登录与调用区分、实际 timeout_ms、timer fired、kill/exit/close、解析/校验、心跳与状态写回。交付：能定位一条尝试卡在模型调用、子进程收尾还是数据库写回。
3. **完成全系统覆盖和查询**：按覆盖清单接数据库、项目/设置/规则管理、文件与产物、全部非 OCR 业务步骤、外部调用和服务异常；补安全查询脚本和 monitor logging 状态。交付：按服务、模块、等级、时间或操作/任务 ID 查询；逐项列明已接入和剩余例外，不能只接 Codex 后宣称全系统完成。
4. **针对性验证与运行验收**：检查日志不泄露材料/密钥，验证并发关联、失败与轮转路径；用合成输入及受控子进程验证诊断链。真实 Codex 调用、服务重启及业务任务重跑分别按明确授权执行。

不更改数据库 schema；如果实施时发现既有 JSON 契约无法承载安全错误摘要，再单独明确必要的最小迁移，不能顺手全量迁移。

## 验收标准与证据

| 场景 | 必须得到的事实 | 验证方式 |
| --- | --- | --- |
| API 入队后 worker 执行 | request_id 能关联 attempt_id，worker 沿同一尝试关联 call_id | 针对性后端测试 + 合成任务日志读回 |
| 全系统覆盖 | 覆盖清单的各类入口有成功/失败证据；OCR 明确列为本轮例外 | 按入口清单追踪代码及针对性场景验证 |
| 非任务操作 | 项目/设置/规则/下载等操作能通过 request_id 或 operation_id 查询，不依赖 attempt_id | 注入管理和文件操作验证 |
| 数据库故障与慢操作 | 连接、查询、事务异常可区分，有固定操作名和耗时，没有 SQL 参数/连接凭证 | 注入数据库故障及受控慢查询验证 |
| 服务异常与监控故障 | 运行实例、异常类别、关闭及监控恢复可关联；未捕获异常不因写日志而被当作正常运行 | 受控进程/监控故障验证 |
| 并发不同题目/同尝试多个调用 | 各自关联正确，没有跨任务字段串用 | 并发上下文单元测试 |
| 正常 Codex 返回 | 从 spawn 到 exit/close、解析、验证及提交均可追溯，已知 usage 保留 | 受控子进程/注入结果测试；真实调用单独记录 |
| 超时或取消 | timer fired、kill 请求、实际退出和业务写回有独立时间；未退出不得宣称退出 | 受控子进程测试，包括退出/close 延迟 |
| 无效输出 | 可区分空材料、页数不匹配、非法 JSON 等，日志不包含文本内容 | 校验失败单元测试 |
| 数据库写回失败/未更新 | 原始错误和写回失败都能查询，不能伪报提交 | 注入数据库失败和更新零行测试 |
| 心跳失败与过期回收 | 最后已确认心跳、恢复/回收事件可见；不覆盖已知原始原因 | 注入时钟/数据库场景测试 |
| 文件不可写、缓冲超限 | 控制台/monitor 显示 degraded 与计数，业务不会因 logger 自身无限等待 | writer 故障测试 |
| 轮转、保留、服务重启 | 新 instance_id 可区分运行，清理仅处理普通日志，有序关闭可读回 | 临时目录文件测试 |
| 隐私 | 对含假密钥/假材料的输入，普通日志与查询结果均没有这些值 | 白名单和输出扫描单元测试 |

按 goal-work 要求，后续后端行为变化必须补针对性单元测试并运行；前端不写测试。当前已运行上表列出的定向测试；后续验证仍不启动 dev server、不调用真实模型、不迁移数据库、不重启服务，也不运行 OCR。

日志功能验收不等于超时根因已修复，也不等于脱敏结果有效。完成本方案实施后，应能以事件时间线解释一次新的失败；历史缺失事件不可补造。
