# 从材料入库到成果导出的工作流与接口档案

**核查日期：** 2026-10-11

**用途：** 为后续设计“由 Codex 按明确指令执行既有工作流”的修改计划提供实现底稿。
**证据范围：** 静态阅读当前工作树中的路由、步骤注册表、队列、状态投影、模块说明和脚本目录；未连接数据库、未请求本地 API、未运行 worker、未派发任务或调用模型。当前工作树有多处未提交改动，本文描述的是本次核查时的源码状态，不等于已运行服务的状态。

## 1. 核心结论

系统已有可供本机程序调用的 HTTP 接口和持久化队列，但尚未发现一个面向业务的统一工作流 CLI。HTTP API 负责校验、冻结任务输入并入队；独立 worker 进程领取任务、调用 Codex 或模型 API、保存结果。调用接口返回“已排队”不代表步骤已经执行完成，必须继续读取题目状态或尝试记录。

用户可见主流程是七步。数据库 `ordinal` 是稳定步骤身份，不等于界面序号；PDF 提取是入库下的内部 `ordinal=2`，不作为独立可见步骤。归档达标题目是主流程最后一步；Excel 是项目级单独导出动作，不是第八个可见步骤。通用自动推进已撤除，只有评分完成后自动运行分数判定，以及显式启动的返修链由 worker 接续。

## 2. 数据对象与边界

| 对象 | 保存内容 | 使用时的区别 |
| --- | --- | --- |
| 项目 `projects` | 项目名称、来源目录、skill 目录及项目默认设置 | 一个项目下有多道题目工作流。 |
| 工作流 `workflows` | 一道题目的来源键、标题、来源文件清单 `source_manifest` | `source_manifest` 是来源目录的文件快照，不等于已入库附件。 |
| 附件 `materials` | 当前或历史附件记录、原件管理路径、指纹、提取/脱敏状态 | 当前附件以 `deleted_at IS NULL` 为准；本地来源文件不会被系统改写。 |
| 当前步骤 `steps` | 每道题每一步的当前状态及当前结果摘要 | 当前状态不能替代历史尝试，也不能单独证明一次请求已完成。 |
| 尝试 `step_attempts` | 单次运行的冻结输入、配置、状态、错误、结果、时间 | `succeeded` 是尝试状态；第七步是否达标要看 `result.decision`。 |
| 产物 `artifacts` | 文件/正文索引、类型、指纹、关联工作流与尝试 | 产物存在不等于成果已归档。 |
| 项目导出 `project_exports` | Excel 导出的批次、题目集合、状态、文件路径和 SHA-256 | 与单题归档分开；题目或达标依据变化后可被标为过期。 |

附件处理边界：来源目录扫描接受 PDF、DOCX、TXT、MD；单文件最多 50 MB，每题最多 100 份且合计最多 100 MB。项目创建/同步扫描来源文件并写入清单；入库时才将材料复制到系统管理存储并写入数据库。PDF 还会创建内部提取任务；DOCX/TXT/MD 走本地解析。入库提取文本与脱敏文本是不同数据，不能把原件下载接口当作作答可用材料接口。

### 来源目录与附件变更入口

| 接口 | 效果 |
| --- | --- |
| `POST /api/projects` | 创建项目并扫描 `material_root` 下题目子目录，登记题目工作流及 `source_manifest`；扫描本身不等于附件已入库。 |
| `POST /api/projects/{projectId}/sync-folder` | 重新扫描来源目录，登记新增题目并更新来源清单；文件指纹/路径变化会触发相应材料结果失效。 |
| `POST /api/projects/{projectId}/workflows` | multipart 上传一份材料包，表单含 `files`、`title`、`source_key`；写入当前材料，含 PDF 时排提取。 |
| `POST /api/workflows/{workflowId}/materials` | 给现有题目增加附件；可用表单 `replace_id` 替换一份。PDF 会触发提取。 |
| `DELETE /api/workflows/{workflowId}/materials/{materialId}` | 移除当前附件并按新附件集合更新输入版本/下游有效性；不是仅隐藏列表行。 |
| `DELETE /api/workflows/{workflowId}/generated` | 清理该题生成结果的重置入口；属于状态变更，不是只读查询或普通步骤重试。 |
| `DELETE /api/workflows/{workflowId}` | 软删除题目工作流，并将活动尝试标为跳过。 |

因此，“从当前等待步骤继续执行”与“重新扫描来源、改附件、清理生成结果”是不同的指令类别；后几项会改变任务输入或删除当前生成状态，不能由通用执行命令顺手触发。

## 3. 可见步骤、内部身份与触发条件

下表的单题入口和项目批量入口由 `server/app.ts` 注册。批量入口只接受可见 ordinal：`1、9、4、5、6、7、8`；不要按界面序号直接拼成 ordinal。步骤 key、ordinal、显示位置以 [`shared/step-registry.ts`](../../shared/step-registry.ts) 为准。

旧 `ordinal=3`（规则版本绑定）和 `ordinal=10`（独立审查）只保留历史身份，不是当前可见步骤或后续门槛。项目 skill 的生成/采用是项目级设置维护，也不是每道题的一步。

| 界面序号 | 步骤 | 稳定 ordinal / key | 单题执行接口 | 项目批量接口 | 核心输入 → 结果与条件 |
| --- | --- | --- | --- | --- | --- |
| 1 | 入库（含 PDF 文本提取） | `1 / receive_materials`；PDF 内部提取 `2 / extract_text` | `POST /api/workflows/{id}/intake`；内部提取另有 `POST /api/workflows/{id}/extract` | `POST /api/projects/{id}/steps/1/run-batch` | 来源目录快照或已提交附件 → 原件管理副本、当前 `materials`、私有提取正文/页索引和识别问题。目录清单变化时会使旧材料结果失效；无 PDF 时内部 ordinal 2 可跳过。上传附件的接口也可能直接接收材料并自动排 PDF 提取。 |
| 2 | 脱敏与检查 | `9 / redact_materials` | `POST /api/workflows/{id}/redact` | `POST /api/projects/{id}/steps/9/run-batch` | 当前已提取原文、当前脱敏设置 → 脱敏正文及索引；可选 API 或本地 Codex 路径取决于项目步骤配置。此步骤变化会影响后续题目、答案和评分输入。 |
| 3 | 出题 | `4 / author_question` | `POST /api/workflows/{id}/author` | `POST /api/projects/{id}/steps/4/run-batch` | 步骤提示词＋当前项目 skill＋当前数据库脱敏附件 → 完整题目包，包括题面、rubric、作答思路、标准答案和版本信息。普通新出题不读取旧题/答案/评分；显式返修会按返修绑定额外携带证据。 |
| 4 | 模型作答 | `5 / model_answer` | `POST /api/workflows/{id}/answer` | `POST /api/projects/{id}/steps/5/run-batch` | 当前题面＋允许的数据库脱敏附件＋项目模型集合快照 → 每个所选模型各自的答案尝试。不是单选一个模型；一题可生成多条模型任务。模型作答不接收 skill、rubric 或标准答案。 |
| 5 | 独立评分 | `6 / independent_score` | `POST /api/workflows/{id}/score` | `POST /api/projects/{id}/steps/6/run-batch` | 同版题面和 rubric＋脱敏附件＋匿名完整答案＋评分步骤提示词 → 每个成功答案各自的评分报告。评分不读取项目 skill、作答思路、标准答案、目标分数或作答模型身份。所有评分任务终结且满足判定条件后，系统会自动运行第七步判定。 |
| 6 | 达标或返修 | `7 / accept_or_revise` | `POST /api/workflows/{id}/accept` | `POST /api/projects/{id}/steps/7/run-batch` | 当前有效模型答案、有效评分、项目模型集合和各自百分制阈值 → `accepted`、`repair`、`waiting` 或隔离类结果。判定是程序计算，不再调用评分模型；所有必需模型都须严格低于各自阈值才达标。步骤尝试 `succeeded` 只表示判定任务完成，需看 `result.decision` 才能判断业务结论。 |
| 7 | 归档达标题目 | `8 / publish_export` | `POST /api/workflows/{id}/publish` | `POST /api/projects/{id}/steps/8/run-batch` | 当前达标依据及产物指纹 → 数据库归档标记。只接受 `accepted`，不会生成独立发布文件。 |

前置条件由 [`workflowStepReadiness()`](../../server/project-folders.ts) 和各队列入队校验共同约束：当前步骤须可执行、未有活动尝试、已启用，最近一个启用的可见前置步骤须完成；第七步可接受已全部终结且至少一个成功模型的部分答案进入评分；第八步要求第七步结果明确为 `accepted`。对 `4/5/6`，已有 `repair` 结果时允许按返修流程重跑。批量派发会逐题返回未就绪原因，不会因为一题失败而把全批都解释成失败。

### 主流程之外但相关的动作

| 动作 | 接口 | 性质 |
| --- | --- | --- |
| 显式返修启动 | `POST /api/workflows/{id}/revisions`，JSON 含 `source_attempt_id` | 创建有预算和绑定的返修链；不是通用自动推进。 |
| 显式返修恢复 | `POST /api/workflows/{id}/revisions/{chainId}/resume` | 恢复已有链；链状态另由 `GET /api/workflows/{id}/revisions` 查询。 |
| 项目 skill 候选 | `POST /api/projects/{id}/skill/generate`；`GET /api/projects/{id}/skill/attempts`；`POST /api/projects/{id}/skill/attempts/{attemptId}/adopt` | 项目级生成、查候选和采用；采用会切换项目当前 skill 路径，不能与单题出题尝试混为一谈。 |
| 结果分项验证 | `POST /api/workflows/{id}/answers/{attemptId}/validate-score` | 接收评分报告并运行服务端评分校验；不是调用评分模型。 |
| 脱敏 DOCX | `POST /api/workflows/{id}/redacted-docx` | 可选导出，不新增步骤，不改变工作流步骤状态。 |
| 项目 Excel | `POST /api/projects/{id}/export`，可选 `{ "batch": "..." }` | 独立项目级导出；`GET /api/projects/{id}/exports` 查询记录，`GET /api/exports/{exportId}/download` 下载文件。 |

## 4. 查阅题目与项目上下文的接口

当前实现没有一个单独的“读题目全部信息”精简端点。可以按查阅目的组合以下接口：

| 接口 | 返回/用途 | 重要边界 |
| --- | --- | --- |
| `GET /api/projects` | 项目列表及未删除题目数。 | 项目详情仍需单独查询。 |
| `GET /api/projects/{projectId}` | 项目对象、工作流列表及每道题的步骤汇总/配置/就绪计数。工作流摘要含来源键、题目标题、附件数、当前阶段、题面/rubric 版本、模型作答摘要、判定及归档/导出状态。 | 使用多个数据库查询；项目/工作流字段较宽，含本地目录和来源清单等元数据。不要把返回对象无筛选地展示给用户或复制进模型上下文。 |
| `GET /api/projects/{projectId}/workflow-status?ids={workflowId,...}` | 一次读取 1–100 道题的步骤状态、可执行性/原因和有限尝试摘要，适合批量筛选当前等待、失败、运行或已就绪题目。 | 这是轻量投影；不返回题面、答案正文、完整评分报告或尝试输入/配置。不能把某个状态摘要当成完整结果。 |
| `GET /api/workflows/{workflowId}?view=status` | 单题详情的状态视图；降低结果正文投影。 | 返回仍含工作流、项目、附件元数据、步骤与尝试摘要；不是最小字段接口。 |
| `GET /api/workflows/{workflowId}` | 单题详情；默认可读当前题目包、模型答案、评分报告和有限尝试详情，并返回附件元数据与产物索引。 | 题目包字段包含 `header`、`task_name`、`task_type`、`question`、`rubric`、`answer_approach`、`reference_answer`、版本等。尝试历史不是无限全量：限制为当前/活动、最近记录和当前答案/评分引用。响应同时包含较宽的 project/workflow 对象。 |
| `GET /api/attempts/{attemptId}` | 按尝试 ID 查 `status/result/error/started_at/finished_at`；可加 `wait_ms` 等待终态。 | `wait_ms` 最大 30 秒；达到等待上限返回 `completed:false`。请求中断只中断等待，不会取消后台任务。`completed:true` 包括 `succeeded`、`failed`、`skipped`，不等于成功。 |
| `GET /api/workflows/{workflowId}/materials/{materialId}/extracted-text?redacted_only=true` | 获取当前附件脱敏全文及可用分页索引，适合需要核对模型实际可用附件正文时调用。 | 不带 `redacted_only=true` 会返回原始提取页，并在有结果时同时返回脱敏内容；读取时校验产物 SHA-256。原始文字是敏感输入，应明确控制是否需要读取。 |
| `GET /api/artifacts/{artifactId}/download` | 下载白名单中的题目、答案、评分、脱敏正文/索引、发布结果等产物。 | 仅支持已登记产物类型；会校验文本指纹。不能用它代替题目/尝试绑定校验。 |
| `GET /api/materials/{materialId}/download` | 下载入库的原始附件副本。 | 返回原件而非脱敏附件；不应默认交给作答/评分任务。 |
| `GET /api/results` | 跨项目当前 `accepted` 题目摘要，附判定、模型名称、归档状态和是否被项目 Excel 导出覆盖。 | 查询条件是达标判定，不等同于已归档；以 `publication_status` 区分。 |
| `GET /api/projects/{projectId}/exports` | 最近最多 100 条项目导出记录。 | 单题归档与 Excel 导出分开查询。 |

### 项目指令、skill 与模型配置读取

| 接口 | 内容 |
| --- | --- |
| `GET /api/projects/{projectId}/rules` | 当前项目工作区、skill 路径、项目文件指纹清单及来源摘要。 |
| `GET /api/projects/{projectId}/rules/file?path=skill/SKILL.md` | 按清单路径读取项目文件；返回内容、SHA-256 与可编辑标记，并在读取前核对指纹。只读与下载由 `download=1` 选择。 |
| `GET /api/projects/{projectId}/agent-settings`（兼容 `codex-settings`） | 项目 Codex 默认模型和强度的读取配置。 |
| `GET /api/agent/config`（兼容 `/api/codex/config`） | 全局 Codex 设置及当前模型目录。 |
| `GET /api/projects/{projectId}/answer-models` | 项目所选模型及各自分数阈值。 |
| `GET /api/answer-models` | 系统模型目录；不等同于项目实际选择集合。 |
| `GET /api/projects/{projectId}` 的 `steps[].config` | 当前各步骤的合并配置及计数；Codex 步骤可能显示来源是步骤设置或继承项目/系统默认。当前没有单独的 `GET /api/projects/{id}/steps/{ordinal}/config` 路由；配置写入/重置是 PUT/DELETE。 |

## 5. 派发、异步执行与读回语义

1. 调用单题或批量步骤接口后，API 检查请求与当前绑定，创建或复用 `step_attempts`，冻结任务输入/配置并交给数据库队列。
2. `server/worker.ts` 是独立消费者。API 进程不会代替 worker 执行 Codex/模型任务；worker 领取、心跳、保存终态和结果。
3. 单题入口可用 `?wait_ms=0..30000` 等待；不传默认为零等待。较长工作应保留 attempt ID，随后读 `/api/attempts/{id}` 或重新读取题目状态。客户端断开不会撤销已入队任务。
4. 项目批量请求 JSON 可省略 `workflow_ids`（项目内全部题目）或提供指定 ID 列表。响应逐题给 `queued`、`succeeded`、`not_ready`、`failed` 或 `not_found`，可能含一个 `attempt_id` 或多模型 `attempt_ids`。`queued` 表示已排队；`not_ready` 表示状态/前置条件不满足；应按每条结果分别处理。
5. 对模型作答和评分，队列可以为每个模型/答案创建独立 attempt。汇总状态只表示该步骤集合状态；需要查看每个模型对应 attempt 及当前题面/评分绑定，不能仅依赖步骤总状态。
6. 运行中任务状态来自数据库当前状态；API `GET /api/monitor` 可读取 worker、活动任务和日志写入健康信息，但监控端点不是题目结果读取接口，也不证明供应商仍在生成。

状态的三个层次不能混用：

- **请求/派发状态**：是否接受、排队、复用或未就绪。
- **尝试状态**：`waiting/running/succeeded/failed/skipped`。
- **业务结果**：例如第七步的 `accepted/repair/waiting/quarantine`、单模型的有效评分及是否低于阈值、是否归档。

## 6. 当前 CLI 与自动化能力

本次查阅 `package.json` 和 `scripts/README.md`：现有 package scripts 是 dev/server/worker/migrate/build/check/backend-test/start；`scripts/` 以启动、日志查询和调查/验收脚本为主，没有发现接受“项目/题目/目标步骤”等业务参数并执行可复用工作流的常规 CLI 命令。验证脚本可能连接数据库或触发真实模型，不能视为日常安全 CLI。

当前可复用的底层能力已经存在：

- HTTP API 提供项目/题目查询、步骤就绪投影、单题派发和项目逐题批量派发。
- 数据库保存当前状态、尝试历史、输入/配置绑定、答案/评分和产物关系。
- worker 消费耗时任务并处理返修接续。
- 项目本地 `skill/` 提供项目任务规则，但它不是现有业务命令行解析器；skill 不能代替服务端状态判断和任务入队接口。

后续计划需要面对的实际边界：接口实现已有，但没有稳定的面向 Codex 的领域命令入口；批量接口只派发一个指定步骤，不会自动从入库连续推进到归档；服务端需运行且 worker 必须在线；客户端要自己管理 attempt ID、多模型 attempt 集合、等待/重读、终态与业务结论，并明确何时停止。通用自动推进在产品中已移除，不应将它误写成现成能力。

## 7. 面向后续计划的固定事实

这些事实适合作为计划输入，尚不是实施方案：

1. 题目是最小工作单元；项目级操作可对指定题目 ID 集合批量处理。
2. 可靠执行依据应为服务端返回的稳定 ordinal/key、就绪状态和当前版本绑定；展示位置仅供界面显示。
3. 先通过读接口收集项目、题目、当前附件及步骤状态；提交前按每题的 readiness 处理，提交后逐条跟踪任务和业务结果。
4. 模型作答要保留每个所选模型的任务与结果；评分按成功答案分别执行；达标是每个模型分别比较阈值后的合取结果。
5. 新题/普通重出、显式返修、评分重跑是不同操作路径；不要把历史反馈自动塞给普通重出。
6. 归档需要 accepted；Excel 导出是另外的显式项目动作；文件生成、单题归档和导出记录分别核实。
7. API 默认服务本机工作台（`127.0.0.1:3100`，Vite 本地页代理 `/api`）；当前不是具备多用户鉴权的远程服务。未来 CLI 只应在明确本机上下文调用，不应将此 API 暴露到公网。
8. 本次仅核对源码和文档，没有验证当前 API/worker 是否启动、模型是否可用、数据库数据是否与源码版本一致。已有测试或历史运行记录也不能替代本次 live 状态确认。

## 8. 主要源码入口

- [`docs/architecture.md`](../architecture.md)：模块、状态和数据边界。
- [`server/app.ts`](../../server/app.ts)：HTTP 查询、配置、派发、返修、发布与导出路由。
- [`shared/step-registry.ts`](../../shared/step-registry.ts)：步骤 key、ordinal 与界面位置。
- [`server/project-folders.ts`](../../server/project-folders.ts)：来源扫描、步骤摘要、批量就绪判断。
- [`server/workflow-view.ts`](../../server/workflow-view.ts)：项目题目状态的字段白名单投影（当前工作树新增文件）。
- [`server/attempts.ts`](../../server/attempts.ts)：单次执行状态读取及最长 30 秒的请求等待。
- [`server/intake-jobs.ts`](../../server/intake-jobs.ts)：来源目录入库队列和 PDF 提取接续。
- [`server/materials/jobs.ts`](../../server/materials/jobs.ts)、[`server/materials/redaction-jobs.ts`](../../server/materials/redaction-jobs.ts)：PDF 提取与脱敏队列。
- [`server/authoring/jobs.ts`](../../server/authoring/jobs.ts)、[`server/answer-models/jobs.ts`](../../server/answer-models/jobs.ts)、[`server/scoring/jobs.ts`](../../server/scoring/jobs.ts)：出题、逐模型作答、逐答案评分。
- [`server/decisions/jobs.ts`](../../server/decisions/jobs.ts)、[`server/decisions/revision-runner.ts`](../../server/decisions/revision-runner.ts)：程序达标、显式返修及接续。
- [`server/publishing/jobs.ts`](../../server/publishing/jobs.ts)、[`server/reporting/README.md`](../../server/reporting/README.md)：单题归档与项目 Excel 导出。
- [`scripts/README.md`](../../scripts/README.md)：现有人工启动、调查与验收脚本的影响边界。
