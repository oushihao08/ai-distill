# 达标题目归档

材料交付名称统一经 `shared/material-filenames.ts` 净化，DOCX与PDF均去掉传入旧名称中的哈希/UUID片段；清理后重名以顺序号区分，并避让已有同名序号。CLI的PDF交付复用同一入口。缺少文书名时仅用“材料”，不从未知正文猜造文种。内部内容校验摘要和私有转换缓存不进入交付名称。此规则只作用于重新导出／上传，不自动改写远端附件。

当前执行绑定以项目、题目、任务、材料包、revision和附件ID为准。已派发任务不再因正文/配置/提示词/整理结果的内容摘要或环境指纹变化而被拒绝；保留任务取消、最新任务归属、材料集合完整性、结构格式和路径边界检查。摘要字段仍用于历史记录、内容寻址及缓存，不作为上述业务执行前后的版本准入门槛。本段覆盖下文历史指纹绑定描述。


HTTP入口持久派发并返回任务ID；worker校验当前达标版本，通过生命周期入口顺序等待项目交付，再记录ordinal 8及归档/撤回事件。归档、文件下载、外部平台提交和平台验收分别记录；归档成功不能冒记为平台提交。

Skill Dependency 的出题后本地直交另由 `GET /api/workflows/:id/skill-dependency-package` 调用其项目目录 `scripts/direct-package.ts`，只读当前步骤4与冻结附件、生成临时ZIP，不写第8步或平台状态；不属于本节的达标归档。

| 文件 | 职责与入口 |
| --- | --- |
| `feishu-delivery.ts` | 飞书多维表格题目交付的唯一共用核心模块：导出 `createFeishuDeliverySession()`、`uploadFeishuAttachments()`（有界并发上传并严格保序）与 `deliverQuestionToFeishu()`（查重、远端附件一致时跳过PDF转换与上传、可选写锁临界区及逐字符回读核验），供 `feishu.ts`、`batch-dispatch` 与 `cli/feishu-local.ts` 共同复用。 |
| `feishu.ts` | 工作流出题草稿上传及已归档题目同步（调用共用 `deliverQuestionToFeishu()`）；直接复用 `exportCurrentMaterialDocx()` 返回的已核验内存字节与本地快照索引，避免重复跨网拉取大JSON；进程内同表写队列配合跨进程有界等待 `feishu-table-write` 咨询锁避免并发交付互拒。 |
| `material-pdf.ts` | HTTP交付与本地CLI共用的材料DOCX到图像PDF转换、15MB连续页分册与已校验分册落盘缓存（`peekCachedMaterialPdfNames()` / `materialPdfAttachments()`）；`scripts/runtime/docx-to-image-pdf.py` 多页栅格化按连续页块跨CPU多核并行执行。 |
| `feishu-verification.ts` | 六字段固定投影、逐字符差异和材料身份校验的纯函数；新记录考点复用豆包普通数字投影，旧版标签仅用于同版旧值核验。 |
| `feishu.test.ts`、`feishu-delivery.test.ts`、`feishu-verification.test.ts` | 隔离验证共用交付引擎、并发保序上传、草稿升归档免转免传、同表写队列互斥、本地快照零跨网读取、真实多核PDF转换与缓存防篡改校验。 |
| `feishu-api.ts` | 交付表字段/选项、建表与隐藏系统关联；直接复用进程内 `createAppClient()`（内置进程级 `tenant_access_token` 缓存与超 20MB 分片上传，无逐题子进程重启开销），结束调用 `close()`。 |
| `feishu-targets.ts` | 期次默认目标配置及一次性新表入口；豆包法律、医疗与返修主项目保持各自冻结期次默认路由，其他主项目默认目标为 `null`（自动归档不误投），支持显式保存 `default_target` 或单次传 `target` 覆盖。 |
| `tasks.ts` | `enqueuePublication()`冻结达标/项目/脚本身份并持久派发（steps 5/6/7 封存期间按 step 4 成功与直交摘要派发）；`runNextPublication()`由worker领取、跟踪心跳/取消、执行项目交付及失败结算。 |
| `tasks.test.ts` | 临时SQLite、SQL/执行器替身与独立随机端口HTTP核对202回执、活动任务复用、失败不误报成功。 |
| `project-delivery.test.ts` | 临时Bun子进程核对有界私有诊断，不运行项目模型。 |
| `jobs.ts` | `publishWorkflow()` 复核当前题目/答案/评分/达标的数据库版本绑定（steps 5/6/7 封存期间直接校验 step 4 成功并以 `author_only_sealed` 供交付脚本使用），执行项目交付并记录归档；`readSiriserArchive()` 下载当前有效 Work 五件套；撤回接口保留历史事件。 |
| `feishu-records.ts` | 按稳定题目ID搜索并回读完整远端记录，供HTTP与本地CLI共用。 |
| `project-delivery.ts` | `resolveProjectDelivery()` 解析主项目 `scripts/delivery.ts`（兼容旧根目录入口）；`runProjectDelivery()` 向独立子进程发送已验证快照；`DeliveryInput` 是交付脚本输入契约。无脚本时使用明确的空实现。 |
| `work-simulation.ts` | 兼容转发旧导入路径；Work 标准成果准备实现位于 `projects/Work法律全场景/scripts/work-simulation.ts`，不在公共层维护项目规则。 |
| `jobs.test.ts` | 验证归档版本、材料/评分绑定、脚本重用、来源模式、撤回与包下载校验；注入执行器不证明真实模型或外部平台成功。 |

## 输入与数据流

豆包新建飞书记录的考点使用1、2、3普通编号，结构化ID、分值及判据不改。普通重试兼容同版旧记录原有的 `R1（1分）` 标签，不自动更新旧正文；显式修订可从两种确定的旧值投影迁移，其他字段及附件仍按原规则核验。代码变化不自动重启服务或同步远端，旧记录也不会因本地编辑被重写。

`publishWorkflow()` 锁定题目，读取当前模型集合与达标配置，校验 ordinal 4–7、达标结果及依据摘要、逐模型答案/评分绑定。数据库中的当前题目、答案和有效评分是归档依据；不额外要求历史 Skill 指纹或同内容的本地题面、答案、评分报告副本。`model_report_v1` 按报告中的 `evaluation_percent` 达标；逐条引文校验不是第二道归档门槛，但答案摘要、评分状态及答案/题面/Rubric 版本绑定仍须一致。其他评分契约仍要求评分校验有效。无项目交付脚本时也可运行公共材料 DOCX 与工作簿导出；辅助导出失败不阻止当前有效达标题目归档。

项目有脚本时，公共层仅按当前达标版本提供题目与判定；可选的 `projects/<主项目>/scripts/archive.ts` 导出 `readConfig()` 冻结必要配置、`prepare()` 准备该项目材料及成果，`scripts/delivery.ts` 实施项目交付。没有准备入口时直接执行交付脚本，其他项目不继承 Work 的材料、场景或文件格式要求。项目脚本目录外的交付规则依赖可由项目自己的 `scripts/delivery-dependencies.json` 路径数组声明并纳入摘要；公共层不维护各项目的规则文件名。准备模块是受信任的服务端项目代码，可使用所需数据库查询；修改准备模块或其导入实现后需按授权重启 API/worker 以加载新代码。交付子进程仍不接收数据库凭证。所有项目在执行准备和交付前提交读取事务并归还连接；Work 标准成果准备也在连接外执行。脚本完成后重新取得连接、开启事务，核对项目/期次身份、题目、模型集合和达标依据未变，之后才写归档记录。文件副作用不能随拒绝归档而自动回滚，仍要求脚本按摘要幂等。冻结的 `work_legal_v1` 成果转换不占 Agent 槽位；只有旧格式生成才等待 Agent 槽位。`work_legal_v1` 分支只投影作者快照，不再调用模型；旧格式的生成受项目模型配置、执行时限和检索证据约束。不要把外层槽位等待当成发生了真实模型调用。

Work 的项目准备入口读取私有题包、达标摘要、当前冻结材料文字及可用结构；仅新材料库题目冻结为 `original` 且来源文件清单与题目材料 ID、名称、SHA 全部一致时，Work 准备模块才把原始文件字节传给本机子进程。脱敏模式不传原件字节。子进程不接收数据库/供应商凭证。相同来源/脚本/身份的活动交付任务复用同一个ID；相同本机任务代次恢复时复用完整的脚本/旧格式标准成果检查点，未确认完成的副作用不自动重放。显式新交付任务仍按项目脚本的幂等约定执行。底层直接归档兼容入口保留旧记录复用。脚本是受信任代码，不是 OS 沙箱；文件和平台副作用不随数据库回滚，脚本必须按来源摘要实施幂等写入。

## 五件套、DOCX 和下载

Work 交付脚本先生成 Siriser 五件套（三份 JSON、`input_files`、`golden_output`）及 ZIP。Harbor `task_id/org` 是可选后续转换参数，提供时仍校验；未提供不阻断五件套。这里不能替用户推断真实平台身份。

Work 的 `input_files` 按题目冻结来源输出：脱敏模式继续由验证后的结构生成 DOCX；新材料库原文模式把来源清单匹配且SHA复核通过的原始附件原字节写入，PDF保持PDF，不经模型或DOCX重渲染。原文模式缺失或错配时归档失败关闭，不降级伪装成原件；多逻辑附件映射尚未支持时也停止。旧无结构脱敏文本走明确的 Markdown 转 DOCX 兼容路径，不能宣称保留不存在的 MinerU 结构。

HTTP归档入口只持久派发并返回任务ID（202），通过attempt接口/CLI等待；不在HTTP请求内运行交付脚本。worker在项目交付（含无脚本空实现）完成后，仍可尝试生成来源模式对应的材料DOCX和单题Excel，通常位于 `assets/out/附件库/<主项目>/<期数>/<题目>/成果/`；完整项目 Excel 是 reporting 的独立操作。项目声明的准备或交付失败仍阻止归档；辅助材料DOCX或单题Excel失败只记录 `supplemental_exports.status=failed` 和安全日志，不改变已达标题目的归档资格。项目必需交付完成后重新核对达标依据，在同一业务事务提交原任务、当前步骤、可用辅助产物索引和归档事件。成果目录保存为 `delivery.output_path`，下载不依赖辅助工作簿存在；兼容旧的工作簿路径索引。输出文件仍不是数据库事务的一部分。单题 Excel 不代替五件套中的专业成果。

`GET /api/workflows/:id/siriser-zip` 和 CLI `siriser download` 重新验证当前达标依据（步骤 5–7 封存期间按 `authorOnlySourceDigest` 校验最新成功出题版本）、题面/Rubric版本、已归档脚本摘要与包索引的一致性、路径及 ZIP 摘要；下载不重新计算当前交付脚本摘要，脚本变更应重新归档。它们只下载文件，不上传 Siriser。旧目录因期次改名仍按已保存归档路径定位，不搬动旧成果。

独立 Work `delivery.ts` 保留旧 API 载荷的只读结构补全路径：使用同工作流、同脱敏 attempt 的现有 HTTP 索引，核对正文与结构摘要后补齐；新载荷已有结构时不再查询。该兼容路径不直连数据库、不修改归档资格。

## 事件与维护边界

归档将项目/题目身份、材料来源、原件和冻结附件摘要保存到归档尝试及 `workflow_publication_events`。`POST /api/workflows/:id/withdraw-archive` 仅撤回当前归档状态，保留尝试、事件和文件；再次归档仍重新校验。材料库使用查询展示这些引用，不代替主项目永久材料使用账中的 `in_use/submitted` 事实。

题面、Rubric、答案、评分或归档依据改变后重新校验，不复用失效成果。项目 Skill 的当前绑定修改不会改写历史题目冻结快照；项目导出可标记过期。有关输入隔离与来源读取的权威入口分别为 [评分](../scoring/README.md)、[材料来源](../question-materials.ts) 和 [材料库](../material-library/README.md)。

## 公共Office生成入口

所有项目可复用[`../document-generation/`](../document-generation/README.md)的`buildDocx()`与`buildXlsx()`；Work正式五件套、材料DOCX归档和通用报表已调用同一实现。旧入口保留兼容导出，不维护第二套生成逻辑。公共能力不替代项目专有交付契约，未实现的项目交付脚本不会自动产生业务成果。

归档失败日志和attempt安全结果记录failure_phase（snapshot/delivery/commit）、安全HTTP状态和稳定`reason_code`，区分达标快照、附件/产物指纹、交付和回写失败；不记录题包正文、材料正文或异常原文。由HTTPException触发的已知校验使用固定原因码；材料库/原件读取错误按受限类别归并，未知错误仍保留通用错误分类。本地评分/答案/题面重复文件缺失或跨机器不可用不再成为通用归档门槛；数据库中的答案摘要、有效评分和题面/Rubric绑定仍须正确。项目必需材料和实际交付文件的路径、摘要及格式校验由该项目入口执行。

## 项目差异与恢复

公共队列只负责派发、冻结依据、等待、取消、恢复和成功边界；正式成果仍由`resolveProjectDelivery()`选择的项目脚本及该项目契约决定，不把Work五件套、文件名或业务内容推广到其他项目。材料DOCX/单题数据工作簿沿用原有辅助归档行为，不能冒充项目专业成果。

第八步使用现有step_attempts和本机internal lane，不新增数据库表。local worker遵守工作流范围；legacy模式由all/local消费者领取，失联只结算失败、不自动重跑。排队后的达标依据、项目/期次身份、脚本或取消状态变化会拒绝发布。旧Work交付仍需Agent时，入队同时冻结当前Agent模型/推理配置，执行前与生成后复核；新格式继续只转换冻结作者成果。已知失败补结算复用原任务检查点；真正结果未知进入needs_review。

脚本失败在成果目录的`.delivery-diagnostics/<UUID>.json`保留stdout/stderr各最多64KiB、退出码及截断标记，目录0700/文件0600。这些输出可能含私有业务内容，只供本机受限诊断，不进入普通日志或HTTP错误。公开日志只记录diagnostic_id；私有文件写入失败另记diagnostic_write_failed，不能声称证据已保存。

期次仅后续作答切换模型（`future_only:true`）时，归档、生成期间复核和五件套下载均通过 `readWorkflowModelSet()` 使用本题答案冻结集合。新默认不使旧归档变成另一模型的结果；题面、附件、答案和评分版本校验不放宽。

## 豆包飞书交付

交付核心逻辑收敛在共用模块 `feishu-delivery.ts`（`deliverQuestionToFeishu()`、`createFeishuDeliverySession()`、`uploadFeishuAttachments()`），由工作流同步 `feishu.ts`、`batch-dispatch` 与本地清单同步 `cli/feishu-local.ts` 共同复用；底层传输直接调用进程内 `createAppClient()`（保留原 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 应用身份，进程内缓存 `tenant_access_token` 并在单会话内并发上传附件、支持超 20MB 分片上传，避免逐题启停 CLI 子进程与临时文件复制）。字段定义、防重、空行备份清理、版本/正文/附件核对和逐目标回执仍在本模块统一维护。官方用户CLI通道独立可选，不改变后台身份；常驻进程需重载后加载最新源码。

豆包法律主项目`315407cd-43db-49d1-8eb3-c2dff77af859`、医疗主项目`e23bfcec-5403-42df-ad92-ea071f6ab24a`与第六期返修主项目`95e1e1d7-a567-4d48-90a6-3191821d93d6`自带冻结期次默认目标路由；其他主项目默认目标为 `null`（自动归档不会误投），可通过 `PUT /api/projects/:id/feishu-delivery` 保存显式 `default_target` 或在同步请求中传入显式 `target` 使用同一套飞书交付能力。归档worker在本地归档提交后读取该期的默认目标并同步；飞书失败单独记录，不撤销本地归档，不自动重跑模型。

医疗主项目与法律主项目共用同一同步与生命周期回调，但期次默认目标分别冻结：法律按期名沿用`PHASE_DEFAULT_TARGETS`，医疗只对`MEDICAL_PHASE_DEFAULT_TARGETS`已登记的期次启用，未登记期次返回`not_applicable`，不按名称临时找表或建表。当前医疗登记「第一期」「第九期」→同一张`第九期-医疗`（`tblDxEX3XN2uYGxV`）：第一期按用户2026-11-10指定，并通过配置接口保存为显式默认目标（`source: configured`）；法律第八期的两个目标不受影响。2026-11-10 已把医疗第一期 6 道已出题题目以草稿形态上传该表（`题目是否完成`=未完成），逐题字段/附件回读核验通过，未改评分、达标或归档状态。

### 默认目标与临时新表

- 每期可保存一个具体目标`{base_token,table_id}`，后续归档追加/更新到此表；不会为每次交付新建表。
- 未配置时保持现有期次路由：当前Base的第六期固定表ID，其他期次按期名寻找唯一表、缺失则首次交付时创建。不是创建期次时立即建表。
- 用户要求把指定N题放入新表时，先固定已达标且已归档的N个workflow ID，创建一个新表，保存返回target，再逐题调用同一单题同步接口并显式传入该target。不得每题建一张表，不从“当前达标数”随意扩大清单；保存逐题回执，失败只补传失败项。
- 一次性目标不改期次默认值。只有用户明确要求后续交付也进入该表，才保存为默认目标。系统支持显式同题多目标；互补分区交付必须由调用方先跨表去重，默认跳过任一表已有完整题。服务端单目标防重单位为“Base＋table ID＋workflow ID”，不按可变任务名称匹配。

新表与既有目标使用同一`FEISHU_FIELDS`定义：15个业务字段及隐藏系统同步ID。新建表沿用统一选项；不复制旧表记录或创建空白占位行。题目ID填写该题workflow UUID，使用普通文本字段，不设置锁定或冻结列。旧记录按隐藏系统同步ID定位，仅补空白题目ID；已有不同ID报告差异，不覆盖。现有表的业务字段缺失/类型冲突会明确报告，不删除或改写该表其他字段。内部系统同步ID可补齐并在grid视图隐藏。

### HTTP契约（本模块权威入口）

| 接口 | 输入和效果 |
| --- | --- |
| `GET /api/projects/:id/feishu-delivery` | 返回当前default_target、来源、`attachment_format`（`docx`或`pdf`）及统一字段；只读。 |
| `PUT /api/projects/:id/feishu-delivery` | `{"default_target":{"base_token":"…","table_id":"tbl…"},"attachment_format":"docx|pdf"}`（至少提供一项）；传入`default_target`时核实远端结构，合并写入project_step_configs.ordinal=8的feishu_delivery键，保留未传字段，不清空题目或归档。 |
| `POST /api/projects/:id/feishu-tables` | `{"table_name":"第六期第二批","base_token":"…"}`；base_token可省略，创建空表并返回target，不改变默认目标；同名表拒绝创建，未知响应先核对远端。 |
| `POST /api/workflows/:id/feishu-sync` | 空body使用期次默认目标与`attachment_format`；可选`target`临时指定目标，可选`attachment_format`（`docx`|`pdf`）覆盖本次附件格式；可设`combined_material:true`（须显式指定格式）先合册再交付。只同步当前有效的达标归档，不重新评分或归档；逐题请求，不将大批量上传放在单次长HTTP请求中。 |
| `POST /api/workflows/:id/feishu-draft-sync` | 同样可省略或指定`target`、`attachment_format`及`revision_attempt_id`；显式`attachment_format:"docx"`或`"pdf"`时可设`combined_material:true`。明确替换同题旧记录时可指定`replace_record_id`（不能与`revision_attempt_id`同时使用）：必须命中同一UUID且完成状态为未完成或已完成的记录，仅更新六项题目正文和输入附件，保留人员字段及原完成状态；旧行系统同步ID为空时补写同一UUID，不覆盖不同ID，并回读核对。调用方须先备份旧记录。要求当前步骤4出题成功且题目尚未归档；不改工作流状态或归档回执。 |

第八期的两个交付目标在 `feishu-targets.ts` 中同时冻结显示名称、`base_token`、`table_id`：“第八期-内部”为本期默认目标，“第八期-久盈”通过显式 `target` 交付。两者均不按名称搜索或临时创表；名称只用于人工识别，业务定位以冻结 ID 为准。

两种同步内容均包括题面、任务名称/类型、rubric、思路、标答文本及该题冻结来源生成的材料DOCX；附件可能是一份合册，也可能是多份分件，具体见下节。不冒填专家账号、xpert uid、行业或标准答案附件。身份列兼容“飞书账号／xpert uid”和“姓名／ID”两组既有表头，交付只校验其存在和类型，不写入这些列。草稿记录明确设为“未完成”。后续正式归档遇到同题草稿时，只在其余字段和材料附件完全一致时将该状态升级为“已完成”；任何差异都停止，不覆盖远端人工修改。题目ID与隐藏系统同步ID均为workflow UUID；任一匹配可定位记录，找到多条报告重复。

### 材料附件生成、上传与题目绑定

PDF转换的LibreOffice查找顺序为`LIBREOFFICE_PATH`、macOS的`/Applications/LibreOffice.app`或`LibreOfficeDev.app`、当前服务用户`~/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/libreoffice-headless/libreoffice/LibreOfficeDev.app/Contents/MacOS/soffice`，最后由Python脚本使用服务PATH查找。自动候选须可执行；不自动安装依赖或修改服务环境。`PYTHON3_PATH`仍可指定转换用Python。代码更新需要API重载后生效，CLI启动环境不会改变已运行服务。

1. 先取当前有效出题attempt的冻结输入与题目版本。材料导出器核对来源版本、材料身份、数量、大小和摘要；不从当前目录另挑材料，也不跨题混合。草稿须出题成功且尚未归档；正式同步须当前归档和达标有效。
2. 有可用材料整理结果时，依其中**可见文书及其顺序**生成；否则按该题原件顺序取冻结正文/结构。普通材料预览仍按[材料导出模块](../materials/README.md#材料docx布局与来源顺序)的项目布局；豆包高经济价值法律与返修主项目未显式配置时默认`attachment_format=pdf`，且飞书交付**一题一份合册**：全部可见文书按冻结顺序合成一个图像版PDF，文件名固定为`案卷材料.pdf`；显式`attachment_format=docx`时仍为合册`材料.docx`。医疗主项目默认继续分件DOCX；显式`combined_material:true`时先合册后转换。整理结果存在但没有可见文书时拒绝导出，不回退整包正文。
3. 按实际导出件顺序读取DOCX字节。分件DOCX交付使用导出的脱敏文书文件名（如`001-民事起诉状.docx`）；分件PDF去除`001-`序号前缀（如`民事起诉状.pdf`，重名为`送达回证（2）.pdf`）；合册PDF为`案卷材料.pdf`。文件名不含哈希、UUID、补零页码或“脱敏/合并”等加工用语。PDF由现有`scripts/runtime/docx-to-image-pdf.py`转换图像版（清空临时页标题；经pdfunite/qpdf拼接切分后不含Title、Producer、Creator及创建时间字段，只清空不伪造），缓存于`<STORAGE_DIR>/feishu-material-pdfs/<workflow_id>/`，依赖本机`soffice`，逐份上传取得飞书`file_token`。所有token填入目标表内**同一workflow UUID对应记录**的“输入附件”字段；“题目ID”和隐藏“系统同步ID”也使用该UUID。先按这两个稳定ID查现有记录，拒绝同表多行命中；不凭任务名称或材料文件名猜测题目归属。
   DOCX 分件超过100份时用本机`python3`的`zipfile`将原分件逐件装入`分件材料（N份）.zip`作为单个附件，内部中文文件名使用UTF-8；ZIP 内的独立文书文件名、顺序和字节不变。压缩失败即停止同步，不回退合册或删减分件。
4. 新建记录后回读本次上传token、附件数量和题目字段；已有记录按当前生成文件的真实名称、数量和顺序核对附件，同时逐字符核对题目ID及六项业务字段；题目ID及六项业务字段完全一致而既有附件为另一种格式或历史`材料-<摘要>`哈希名时，允许原地替换为当前真实名称附件。远端差异或来源在过程中变化则停止并记录失败。这里**不下载远端附件逐字节复核**；`succeeded`表示本次远端记录和附件关联回读通过，不等于平台后续人工验收。

### 回执、失败与验证边界

步骤8及对应当前归档attempt的`result.feishu_sync`保留最近同步回执；`result.feishu_deliveries[base_token/table_id]`按目标保存回执，不用新表提交覆盖旧表提交记录。已有记录的附件按真实文件名、数量与顺序核对并复用；新建记录的创建请求使用独立随机幂等键。改默认配置不会把历史题目自动补传到新表。

凭证缺失、权限、字段冲突、来源变化、重复记录和网络不明响应均保留失败，不盲重试未知写请求。显式事务内的事务级advisory lock兼容PgBouncer事务池；材料导出先归还连接，再进入远端同步事务，期间复用同一连接。并发建表竞争只报告本次请求冲突，不创建重复表。

此前第六期单题已实测文本、DOCX字节和同表重复更新；可配置目标、多表独立回执、新表及空ID模式仍需分别实测，不能用旧验收替代。源码修改不代表常驻API/worker已加载；服务重载遵守授权边界。本配置未新增页面控件；HTTP API及CLI的feishu命令供程序/Agent操作，CLI入口见[操作说明](../../cli/README.md#豆包飞书交付)。CLI会先核对后端能力标记，旧服务不会被当作支持指定目标。

当前步骤8成功的题目拒绝重复归档派发（409），批量派发返回 `already_archived` 跳过；不会因再次点击而清空归档结果。查看、下载和DOCX辅助导出仍可用。飞书首次上传与已有记录同步使用独立入口。

飞书同一目标已有记录也须回读核对；只有本次核对通过才返回 `succeeded`、`reused:true`。自动归档接续不恢复人工删除的记录；用户显式调用补传入口时，核实远端已不存在该题后允许重新创建。旧记录只补空白题目ID，不自动覆写正文差异或重复上传附件。不同目标独立保存回执；本轮未重新验证真实上传。

创建请求的 `client_token` 使用每次创建独立的随机UUID，不再由题目ID固定推导；隐藏的系统同步ID仍使用稳定题目UUID，以目标表内实际记录防重复。一次请求失败不自动更换token重发。创建后回读文本及附件token一致才记录成功；显式补传可重建已删除记录，自动归档接续不恢复删除。源码修改须重载API后生效，不能把接口成功与人工后续编辑混为一谈。

上传前在同表事务锁内清理空占位记录：全部业务字段和自定义字段为空、仅隐藏系统ID及空父记录引用时，先保存本机 `.storage/feishu-row-cleanup/` 备份，再逐条重读并删除。有任何实际字段值或父记录关系的行保留。有效题目不重建，新增记录由飞书追加到现有记录之后；视图若另设排序或分组，则可见顺序仍由该视图决定。空行清理不是用新题覆盖其他题目的record_id。

### 飞书交付一致性核对

适用于豆包现有飞书交付入口，不增加模型审查或定时任务。`feishu-verification.ts`统一六字段投影与精确比较；rubric保留条目、分数、标准及计分规则。生成前将有效出题attempt的材料artifact ID/SHA及来源版本与DOCX读取源比较，随后核对原件数量、材料ID、SHA和记录的字节大小；共享材料对照快照关联的源artifact大小。旧来源以出题绑定的脱敏attempt输入校验原件集合，实际字节大小由同SHA原件复核。材料身份或冻结正文证据不符即失败，不补造历史数据。脱敏DOCX读取已核验的冻结正文，原始PDF本机备份缺失不阻断跨机器交付；存在但大小/SHA错误的备份仍拒绝。普通材料预览导出不增加出题门槛。

新建或已有记录均逐字符比较题目ID、六字段；缺失、空格、换行、截断均报告差异。附件核对本次上传token，已有附件按生成文件的真实名称、数量与顺序匹配；不下载远端文件。处理前后复核题目全文版本、出题输入和归档attempt，晚到结果不能写入新版本。首次按workflow ID读取题目，再以该题版本作为独立参数读取匹配出题attempt；冻结输入仅返回材料绑定字段及覆盖完整输入的SHA-256，后续校验在数据库比较完整题目JSON、完整冻结输入SHA-256、匹配attempt ID和归档身份，仅返回布尔结果，避免相关子查询反复读取完整正文。新建记录保留锁内、写前及回读后的校验，写前不再紧邻重复查询两次。同步请求不再由HTTP空闲超时提前断开，外部调用截止与客户端等待预算仍各自保留。此优化需API重载后实测耗时，源码变更不代表性能已改善。

`feishu_sync.verification`记录`passed`、`failed`或`incomplete`，带检查时间、题目/rubric版本、安全差异字段及字符位置；不保存正文片段。差异停止当前题交付，网络错误记未完成；本地归档不回滚。工作流API仅投影安全回执，题目页面明确展示通过/失败/未完成、差异项和飞书链接。CLI批次保留逐题回执并汇总已通过/差异/未完成数量；旧回执无verification不能当作本次核对通过。源码需经授权重载后才生效。

生命周期回调由[同步增强层](../lifecycle/README.md)统一注册，事件接入现有执行/保存边界；无注册时保持原流程。

### 项目生命周期注册边界

项目专属交付注册集中在 [lifecycle/projects](../lifecycle/projects/README.md)：Work 与豆包各自独立文件。公共 jobs/tasks 只把当前主项目 parent_name 作为 key 传给统一生命周期入口，不在步骤中写项目分支。归档前准备/交付及归档后交付均顺序等待；没有专属注册的项目保留默认可选脚本行为。脚本目录和协议实现继续复用，不复制专业逻辑。

飞书返回 failed、remote_deleted、in_progress 或 not_applicable 均报告本次交付未完成，不再因接口正常返回而发完整交付成功事件。已经保存的本地归档仍保留，飞书独立回执用于展示与补传；这是本地归档与远端交付两个状态，不把远端失败改成重新生成题目。

通用交付载荷中的项目扩展字段也通过publicationFields注册投影；Work字段清单不在公共publishWorkflow里展开。原Siriser专属下载接口保留名称和包索引协议，项目下载资格改由注册策略提供；这不增加通用归档准入。

CLI等待仅确认本地归档attempt终态。`workflow delivery show`通过工作流详情轻量视图读取最近及逐目标飞书安全回执；它不访问飞书、不补传、不替代当前版本与准确目标核对。命令及未知状态恢复见[CLI说明](../../cli/README.md#显式恢复与交付确认)。

本机明确新派发可在同一事务替代他机尚未开始的同范围待办；运行、结果未知和续作仍受保护，新派发失败则旧意图变更回滚。适用范围、共享状态兼容与验证边界见[执行队列的跨机准入](../execution-queue/README.md#他机未开始待办与本机明确派发)。

### 显式草稿修订同步

草稿同步可携带 `revision_attempt_id`，必须与当前题包 `manual_revision.attempt_id` 一致。主体名称修订会在本地尝试中同时冻结修订前后的六项题目字段、材料绑定和旧材料 DOCX 真实文件名（兼容既有记录中的历史`材料-<摘要>`哈希名）；既有记录只有完整匹配旧字段及旧附件时，才上传新附件并把发生变化的题目字段精确迁移到新值。远端已是完整新值时只回读核对；出现新旧混合状态、缺少旧附件证据或未知写入时停止，不自动重发。更新后回读全部字段并拒绝无关字段变化；普通同步继续拒绝远端正文差异。飞书账号允许既有人员字段或文本字段，本同步不写该字段。

脱敏建题显式 copy_originals=false 的冻结来源使用 original_copy=omitted 标记；交付按冻结 library_file_id/revision 和库原件摘要/大小核对，不要求不存在的本机原件副本。旧快照无该标记仍遵循原校验。

材料PDF上传统一经`materialPdfAttachments()`生成带名称的附件列表：本系统单份上限为15,000,000字节（飞书平台上限18MB，留出余量），超限复用`server/materials/pdf-split.ts`按连续页平均无损拆分，每份实测大小不超限才采用；分片缓存内部仍按页码命名用于校验，**交付名改为册序**，如`案卷材料（第一册）.pdf`、`案卷材料（第二册）.pdf`；未超限为`<文书名>.pdf`。回读数量按分册列表校验。缓存键包含上限值，改上限后自动重新切分；单页仍超限则失败，不压缩降质、不省略页。CLI立即使用当前源码，HTTP须运行实例加载新代码后生效。

### 交付效率与当前限制

1. **避免重复跨网拉取多MB材料索引**：`readCurrentRedactionForDocx()` 复用 `readQuestionMaterialsWithIndex()` 已从本地快照缓存校验读取的 `snapshot_manifest` 与 `parsed_index`；`exportCurrentMaterialDocx()` 直接随返回值附带已核验内存 `files` 并在全部附件与唯一 manifest 未变时跳过无变更数据库写往返，`feishu.ts` 不再二次回查材料索引与 artifact 表。
2. **进程内会话、惰性转换与并发上传**：`feishu-api.ts` 使用进程内应用客户端缓存 `tenant_access_token`，不再逐文件重启 CLI 子进程；`deliverQuestionToFeishu()` 在远端已有同题记录且附件名已匹配（如命中 `peekCachedMaterialPdfNames()` 分册缓存或草稿升正式归档）时直接跳过 PDF 转换与媒体上传；需要上传多份分件/分册时通过 `uploadFeishuAttachments()` 默认 4 并发上传并按原索引保序。
3. **PDF 分册缓存与多核栅格化**：`material-pdf.ts` 按输入 DOCX 字节摘要与分册上限持久化已校验分册清单缓存，同源重复交付或草稿升正式交付直接毫秒级命中；冷启动转换时 `scripts/runtime/docx-to-image-pdf.py` 在校验内嵌中文字体后按连续页块跨多核并行栅格化合并。
4. **同表并发安全**：慢速 DOCX 导出、PDF 转换与飞书素材上传均在数据库事务外并发执行；最终记录写阶段经进程内同表队列与有界等待的 `feishu-table-write` 咨询锁串行进入，CLI `feishu draft-sync-batch` / `sync-batch` 与 `batch-dispatch` 交付池默认支持 4 并发而不互相争锁报错。

注意：服务端 HTTP 与常驻 `worker` 需在获得授权重启后才会加载上述最新源码（CLI 本地命令立即加载新代码）；真实飞书送达耗时改善仍须在重载后凭实际批次请求和回读回执验收。
