<!-- 文件职责：说明全局材料库的存储、处理配置、API、任务、项目加载与文件阅读。 -->
# 独立材料库

本模块管理不属于任何项目的材料包和不可变文件集合。同一包可加载到多个项目（包括既有 legacy 项目）。期次出题设置默认选择成功脱敏版本，也可选择已完成 MinerU 提取的原文版本；题目级 `question_library_sources` 冻结来源模式、版本与正文/索引，后续出题、作答、评分和交付均按该快照读取。原文模式只发送已提取文本与结构，不发送原始二进制。未绑定共享库快照的旧题继续走原步骤 1/9，旧目录建题流程仍只支持脱敏；共享材料快照题可用于新旧项目，项目 `material_backend` 不因此改变。入库/提取/脱敏不创建旧材料包工作流，也不向 legacy 材料表写库级原件。

## 模块与存储

| 文件 | 职责 |
| --- | --- |
| `storage.ts` | 原件内容寻址安装、受管路径/符号链接边界和字节摘要校验；提取、旧导入及代称计划共用`insertLibraryTextBlob()`，统一正文/MIME/UTF8字节数复用校验 |
| `service.ts` | 包资料、不可变文件集合、上传幂等、逻辑归档/恢复、历史与使用查询；保留初始配置构建及校验函数 |
| `settings.ts` | 共用SQLite配置数据库；首次读取初始化并持久化默认模板，每次派发重新读取；乐观版本控制、事务保存，不保存密钥 |
| `jobs.ts` | 入队时读取共用设置并冻结；请求重放、执行lane、租约、取消、失租和终态事务 |
| `runner.ts` | 领取后的调度、心跳、取消与截止；入库和提取执行 |
| `redaction-runner.ts` | 按已冻结方式执行遮挡/化名脱敏并事务发布，复用旧结构输出 |
| `execution-shared.ts` | 执行器共用摘要、私有目录及提取结构校验 |
| `processing-policy.ts` | 从期次配置读取三模式并约束派发模板；不调用模型 |
| `agent-redaction.ts` | 单次限时Agent调用及最终程序编译；不入队、不自动重试 |
| `agent-redaction-artifacts.ts` | 私有输入、同源检查点、固定结果文件及本地校验工具准备 |
| `agent-redaction-validator.ts` | 打包到任务内的只读校验CLI，供Agent在同次调用内修正错误；不写库 |
| `redaction-review.ts` | 显式复核Agent已发布产物，将当前结论及历史追加到job.result_summary，不改不可变产物或任务成功历史 |
| `worker-once.ts` | 验收入口，只消费HTTP已创建的指定本机Agent材料job UUID，复用共享Agent槽位与正式事务，不领取其他任务 |
| `prepared-import.ts` | 导入Codex已审阅的原文编辑/分册计划：校验完整提取来源、精确编辑、范围覆盖与请求幂等，在同一事务保存新任务及脱敏结果；不OCR、不调用模型、不改旧结果 |
| `preview.ts` | 按文件/成功提取任务/成功脱敏结果身份按需读取正文，校验摘要；单文件脱敏通过索引定位，拒绝任意blob读取 |
| `original-preview.ts` | PDF/TXT等原件直接查看，DOCX由隔离LibreOffice生成只读PDF副本；串行转换、60秒时限、按源摘要和渲染版本缓存 |
| `projects.ts`、`questions.ts` | 项目加载与选版/移除；按期次所选模式从脱敏结果或 MinerU 提取版本建立完整题目私有快照 |
| `projects-routes.ts`、`uses.ts` | 本期材料候选分页、加载引用/恢复、题目创建入口及本期使用状态/单条事件读取 |
| `routes.ts` | `/api/material-library` 的资料、版本、任务、配置、预览和使用关系接口 |
| `legacy-import.test.ts` | 旧包原件/成功提取导入的页序、摘要、状态与原期使用关系校验；不测试脱敏或修改旧题 |
| `projects-routes.test.ts` | 候选分页与并行读取、已移除引用恢复及单条使用事件路由边界 |
| `uses.test.ts` | 原件集合身份、跨期占用、原期返修、提交证据和事件摘要边界 |

原件位于`<STORAGE_DIR>/material-library/blobs/`；共用处理设置位于同目录下私有`processing-settings.sqlite3`；DOCX预览缓存位于`previews/`，转换临时目录和用户profile使用后删除。所有SQLite配置供同一STORAGE_DIR的本机API实例共用；未承诺多台独立API自动同步本地配置。worker读取已冻结的PostgreSQL任务快照，不在执行中重新读取本地共用配置。

Agent本地校验器打包为Node兼容ESM；Windows使用`node --preserve-symlinks-main --preserve-symlinks validate-plan.mjs`，避免MXC默认拒绝读取父目录时运行时真实路径探测失败。其他平台继续使用`bun validate-plan.mjs`。调用命令由程序提供，不修改数据库中的业务脱敏规则。

包名称/说明/标签与处理设置分开。历史`library_packages.processing_settings`保留兼容初始快照，不再作为新任务执行配置，也不从包详情返回；包创建/更新接口拒绝单包处理配置写入。未保存共用配置时，从数据库系统提示词与当前系统模型/提取默认组合完整配置。保存后的共用设置只影响之后派发的新任务，历史任务与题目快照不回写。

## 期次三种处理模式

设置权威字段是出题步骤（ordinal 4）JSON配置中的`material_processing_mode`；由现有步骤设置API持久化，UI/CLI共用，不由Skill或提示词决定。`GET /api/projects/:id/material-processing`读取实际模式。旧`material_source_mode=original`兼容原文；无设置默认`aliases`。

| 值 | 处理入口 | 建题及后续来源 |
| --- | --- | --- |
| `original` | 成功入库/提取后不派发脱敏 | 冻结提取原文与结构；出题、作答、评分、交付共用该快照 |
| `mask` | 带`project_id`派发任务，程序选择mask模板和已配置API模型 | 仅选择遮挡结果，冻结为redacted |
| `aliases`（默认） | 带`project_id`派发任务，程序选择整包化名模板，当前由本机Agent执行 | 仅选择化名整理结果，冻结为redacted |

材料任务请求可带`project_id`：服务端从该期次配置选流程，拒绝不一致的客户端模板，原文模式不派脱敏；新任务冻结模式及处理配置，历史任务不切换。未带项目上下文的全局库操作仍可显式选择模板，供不同项目共享已处理版本。API遮挡模型未配置时报告配置缺口，不改用Codex。化名方法与执行适配器分离：当前接`runAgent`，未来API Agent后端可实现同一任务/结果接口，尚未宣称该后端已实现。

本期可先加载已提取、尚待脱敏的材料，点击“处理材料”进入带期次上下文的材料页。处理成功后选择匹配版本再建题；不恢复通用自动推进。改变本期模式只影响新题；既有题目依然按题目快照执行，禁止作答/评分临时重读当前模式并切换材料。成功消息或阶段文件不等于发布成功：以library_jobs.succeeded和library_redactions可读结果为准。

## 页面与接口

`POST /revisions/:id/prepared-redactions` 接收 `{request_key,plan}`，由 CLI `library documents import` 调用。协议与坐标见 `cli/README.md`；原文编辑/代称计划私有保存在任务配置，不由普通任务详情返回。安全分册正文和范围进入不可变脱敏索引 `prepared_documents`，随题目来源冻结。带 `codex_plan` 模板摘要的计划按MinerU已提取结构保存分册文书；旧版不带模板的计划继续按提取页文本兼容导入，标记 `structure_mode=extracted-page-text`，不宣称保留表格合并结构。`usable_for_question` 表示机械校验可处理，不能证明主体归并、脱敏或OCR内容人工验收通过。

材料库从本机文件夹导入PDF/DOCX/TXT/MD，手动执行入库、识别和脱敏。页面默认以文件为中心：原文件、识别原文、单文件脱敏文本、对应版本对照；历史任务放在“处理记录”，按题目汇总使用状态，展开才显示归档/撤回时间线。更新文件创建新集合，不修改旧文件。

- `GET/PUT /processing-settings`：读取/保存全库共用处理配置；PUT必传If-Match版本，首次保存版本为0，冲突409。
- `GET /processing-defaults`：当前系统默认，仅显式应用到共用设置草稿。
- `GET /files/:id/content`：下载原件；`GET /files/:id/preview`：原文件内嵌预览。先核对file→revision→package、执行端、路径、摘要和大小。DOCX预览依赖已安装的LibreOffice（可通过LIBREOFFICE_PATH指定）；不上传第三方，不调用模型。生成副本的分页可能受可用字体和渲染器影响，原件始终保留。
- `GET /revisions/:id/documents?extraction_job_id=...`：成功同集合提取任务的文件摘要/识别问题；加file_id按需读取单文件正文。
- `GET /redactions/:id/preview`：成功脱敏全文；加file_id返回该文件页文本，并返回实际extraction_job_id，前端对照读取这个提取来源。
- `GET /packages?ready_only=true`：在分页前按全部历史可用脱敏结果过滤；`archived_only=true` 列出已逻辑归档包，默认仅返回使用中的包。每页还返回材料使用轻量摘要（主项目、所属期、使用中/已提交），不带事件详情；新文件版本失败不隐藏旧成功版；POST加载/PATCH选版在包/项目事务锁内再次验证非空且有效的选择。
- `DELETE /packages/:id`：按 `If-Match` 版本逻辑归档；若仍有运行中或排队的材料处理任务则拒绝。不会删除原件、历史、项目加载关系、题目私有快照或归档事件。`POST /packages/:id/restore` 可恢复已归档包。
- `GET /packages/:id/usage`：加载项目与归档/撤回事件。界面按题目汇总当前状态，事件历史保留；移除引用和删除项目不改变全局库包。
- `GET /projects/:id/material-candidates?q=...&page=...&page_size=...`：本期材料加载弹窗的搜索和分页候选；项目占用状态在同一候选查询中投影，避免目录结果后再发一轮使用记录查询；页面只在打开弹窗或改变查询时请求当前页。
- `GET /projects/:id/loaded-materials?include_removed=true`：返回本期当前和已移除的材料引用；已移除关系可由 `POST /projects/:id/loaded-materials/:linkId/restore` 恢复。
- `GET /projects/:id/material-uses/:useId/events`：读取单条使用关系的提交/返修事件。`GET /projects/:id/material-uses` 只返回状态摘要，不把全期事件历史放进首屏响应。
- `POST /projects/:id/loaded-materials/:linkId/questions`：按本期出题材料模式从指定脱敏结果或 MinerU 提取版本创建题目；题目名称、场景、角色视角、出题方向、等级和本期标签随请求传入，并进入题目快照及摘要防重键。
- 项目工作流列表只投影页面使用的题目字段及共享材料包来源 ID/名称，不返回 `source_manifest`；单题详情仍按既有接口读取题目材料来源清单。

正文预览上限4MiB，超过时明确拒绝而不是截断。原件PDF按原字节返回；DOCX缓存最大32MiB，缺转换器、超时或转换失败显示可操作错误。macOS的部分headless发行版遗漏当前系统字体资源路径，会出现可复制但不可见的中文；转换只在私有临时fontconfig中补入系统字体目录，不安装或修改全局字体。

任务详情只投影身份、状态、计数、安全错误、previous_job_id、extraction_job_id、cancel_requested_at；不返回input/config快照。取消排队任务同步终止，运行任务等待执行器结束；失租不退回排队。重试新建任务并保留来源，使用新的共用配置。旧缺少冻结PDF供应商的任务不能默默改用新环境，需新尝试。

## 验证与维护边界

脱敏派发、执行及建题来源复制前共用 `assertLibraryExtractionUsable()` 检查文件、页数和正文可处理性；整个文件无正文时在模型调用前明确拒绝，空白页随有正文的其余页保留。OCR issues 是识别提示，不能等同于脱敏丢失内容，不再仅凭提示数量阻断脱敏或建题。提示保留在提取文档、脱敏索引及 validation_report.extraction_issues 中，原件摘要、页/字段覆盖及原文定位仍校验。脱敏验收比较已提取原文与脱敏正文的实质内容，允许正常遮盖及无实质影响的格式差异；usable_for_question 表示输入和脱敏产物可用于建题，不证明原PDF逐字OCR准确。此政策不回写历史任务/产物。

以下文件是源码级替身测试，不连接真实 OCR、脱敏模型或外部平台；具体检查边界如下：`storage.test.ts`验证原件内容寻址、字节重校验和文件名边界；`service.test.ts`验证资料过滤/版本、逻辑归档恢复及使用历史投影；`jobs.test.ts`验证提取/脱敏来源校验、执行lane、取消、失租和晚到结果；`projects.test.ts`验证加载关系和选版；`projects-routes.test.ts`验证候选分页、恢复和按单条读取事件；`questions.test.ts`验证题目字段、摘要和脱敏/原文快照；`preview.test.ts`验证正文摘要与文件身份限制；`legacy-import.test.ts`验证旧数据导入不伪装提取/脱敏结果并保留原期关系；`uses.test.ts`验证材料使用签名和跨期/返修状态边界。测试文件存在不代表本轮已运行，也不证明真实 OCR/脱敏质量。

数据库是否具备所需迁移必须查询目标环境，不能由本说明推断。历史检查只证明其记录的时间、输入和范围，不代表当前环境或真实模型质量已验收。

文件系统与PostgreSQL不是同一原子事务；提交未知时保留对象并按幂等key核对，不因单请求失败清理可能已被引用的blob。旧流程保留，不迁移或清理旧业务数据。

材料包列表支持 `q`、重复的 `project_id`、`redaction_state=all|ready|not_ready` 组合筛选，筛选在分页之前执行。项目多选取当前有效加载关系的并集，忽略移除关系及已删除项目；脱敏状态按是否存在成功且可用于建题的版本判断，兼容原 `ready_only` 参数。`GET /api/material-library/project-options` 提供未删除项目的轻量选项。


## 主项目期次与历史入库衔接

`uses.ts`维护独立于题目生命周期的材料使用账：同主项目跨期禁止重复使用，同原期允许返修；submitted回到in_use必须填写原因并保留事件。`legacy-import.ts`提供旧材料预检、入库原件/提取结果导入及原期关系激活，不导入旧脱敏成功状态，不修改题目私有快照。来源映射保存在legacy_material_imports，不能替代question_library_sources。

历史同步通过HTTP的legacy-material-imports接口执行；预检摘要用于apply时重验。上传平台事实只能按真实回执另行登记，归档成功不等于提交成功。

## 使用账与执行位置的准确边界

- 主项目内的占用按同一 `package_id` 或完整原件集合签名判断。签名对原件 SHA/大小去重排序，不受文件名和顺序影响；它不是任意部分重叠检测。同一期每个活动材料包只能创建一道活动题；软删除旧题后可创建替代题，历史仍保留。包名明确标注L2–L5时，建题目标等级必须一致。同一主项目其他期不能重新占用；返修回到原所属期，事件账独立于题目保留。
- 使用状态更新必须带原因和乐观版本。登记 `submitted` 时，`evidence` 必须包含非空的 `platform`、`project_id`、`task_id`、可解析的 `submitted_at`、`receipt`；字段完整性校验不等于系统已向外部平台验证真实性。
- 普通上传当前将原件安装为 `storage_target=local`。任务要求所有原件目标与 `execution_target` 一致，服务器执行并不自动搬运原件；题目来源私有复制当前也要求本机可读来源。旧 remote-material 同步接口处理旧工作流，不负责搬运全局材料库 blob。
- 建题请求用 `request_key` 防重，同时校验 `expected_link_version`；来源字段为 `redaction_id` 或 `revision_id` 二选一，并与本期出题模式一致。成功后冻结快照，后改期次设置不切换旧题来源。

旧材料导入默认 `dry_run=true`，apply 必须显式传 `dry_run=false` 和预检的 `expected_source_digest`。只有所有文件均有校验通过的旧提取结果，才登记完整成功的导入提取任务；部分提取不冒充完整成功。激活仅衔接原期材料引用/使用账，可能保留未选版本，仍需选取可用来源才能新建题目。


## 脱敏模板

当前执行分支按来源和操作选择，不是依次运行两套脱敏：

| 操作/来源 | 实际执行入口 | 结果及后续 |
| --- | --- | --- |
| 上传文件集合 → 入库 | `createLibraryRevision()` → `intake`内部任务 | 校验原件和清单；不自动提取或脱敏 |
| PDF/DOCX提取 | `extract`任务的API执行通道 → MinerU | 冻结提取文档；不冒记为已脱敏 |
| TXT/MD提取 | `extract`内部任务 → 本地解析 | 同一提取文档契约，不调用OCR模型 |
| 字段遮罩模板 | `redact`任务 → `redactExtractedMaterials()` | API/Agent按冻结配置执行；全部声明已脱敏的附件走内部校验 |
| 整包化名模板（默认） | Agent消费池 → 语义计划编译 → 既有结果事务 | 固定虚构姓名、法院保留、精确编辑与结构分册；最多10分钟，私有进度保留 |
| 原文建题 | 成功提取版本 → `createLibraryQuestion()` | 冻结`original`来源；可不脱敏 |
| 脱敏建题 | 与本期处理模式一致的成功脱敏结果 → `createLibraryQuestion()` | 冻结`redacted`来源；下游不再选择模板 |

CLI与HTTP的计划入口共用`shared/material-preparation.ts`的`validateMaterialPreparationPlan()`；随后按具体来源校验精确编辑、结构和全文覆盖。没有模板字段的旧计划继续兼容；显式模板必须同时提供有效`template_id/template_digest`，空值不能当作旧计划处理。

旧文本计划只产出编辑后文字，由导入入口构建明确的段落结构；不沿用编辑前的表格/段落对象。整包模板计划才通过结构编辑器生成编辑后结构，避免正文与旧结构不一致，也避免把旧文本计划冒记成保留原结构。

模板与材料包、项目身份分开。`GET /redaction-templates`读取模板提示词、workflow及digest；`mask`固定引用原有共用`redaction`配置，无项目上下文时旧请求可显式template_id=mask，省略则使用aliases默认流程。共用设置可保存最多20项`redaction_templates`，每项id/name/workflow/redaction独立；新安装或已保存空数组时提供内置Codex整包模板；不保存密钥。

- `field_mapping`：普通redact请求可指定template_id；入队冻结选中提示词、模型配置和模板摘要，worker不再读取当前模板。
- `codex_plan`：默认aliases模板，省略template_id也选择它。每次入队读取共用SQLite配置数据库中的提示词并冻结模板及系统Agent模型；既有Agent消费池整包执行，不调用字段映射API。`shared/agent-material-plan.ts`将字段片段与结构块范围编译为既有精确计划，再做无重叠/全文覆盖/结构校验。主体对应表和阶段进度保留在`jobs/<job-id>/private/`（700/600），不进入题目或交付。任务领取至发布最多10分钟，截止停止子进程并以agent_redaction_timeout终结，不自动重试。显式重试只复用同输入/模板/模型的私有进度。人工CLI精确计划导入仍须绑定template_id/template_digest，保留原幂等行为。

模板计划沿原提取structure应用字段内编辑，保留行列和rowSpan/columnSpan。跨字段编辑、切断表格或列表、正文覆盖/结构投影不一致均拒绝；原始结构缺失不得静默回退。CLI原文单文件返回structure和field_ranges供定位。索引prepared_documents包含分册document，供通用材料DOCX和Work五件套共用；旧文本型分册仍走兼容渲染。结构保留不等于原始OCR结构准确，须渲染核查异常表格。

新结果不自动选入项目或修改旧题；新题按已有来源快照机制冻结具体结果。无需新增表迁移；模板提示词保存在本机SQLite，期次处理模式保存在PostgreSQL的project_step_configs.config.material_processing_mode；题目、答案、评分与归档不自行选择模板。

历史导入曾将 PDF 的识别类别 `scanned`／`text` 写入原件 MIME。再次上传相同 PDF 时，入口在文件签名、SHA、大小和受管路径一致后，仅兼容这两种历史类别并复用不可变对象；其他类型冲突仍拒绝，不改原件字节或题目快照。

同字节的TXT/MD可以复用一个原件对象，文件集合仍保留各自文件名、位置与脱敏声明；复用不改旧对象MIME，也不放宽PDF/DOCX等二进制类型冲突。提取时以本次文件名确定TXT/MD解析路径。

## Agent材料执行与验收

语义协议和编译器以`shared/agent-material-plan.ts`为准。模型只提供固定主体表、需要处理的字段原文/类别和文书首尾块ID；程序生成原页及编辑后坐标、按规则遮盖、清除明确图像占位符及独立字段“无法识别”并拒绝其残留、验证完整覆盖。共享主体表避免各批次独立起名；重复扫描保留并关联，当前不自动去重。两套脱敏执行分支的成功结果仍进入相同library_redactions及prepared_documents/题目快照链路。

边界不清的连续附件可完整保留为组合文书；身份归并不明时不强行合并，敏感名称使用独立主体ID和字段作用域化名。未确认的归并或精确分册写私有非阻断疑点；隐私片段未安全处理或正文无法完整覆盖仍阻断。该处理由本次数据库模板指导Agent决定，编译器不擅自把blocking改为false。

Agent完整语义计划交付到固定私有文件`output/material-plan.json`（结构见任务内`plan-schema.json`），最终消息仅声明`plan_file`；执行器在Agent正常完成后读取该文件并编译发布。阶段文件或成功消息本身不等于发布完成，缺文件、空计划、源文覆盖缺失仍失败；不从聊天摘要补造正文，也不要求模型再在最终消息重复整份大JSON。

`agent-redaction.test.ts`验证数据库重新读取、私有主体表保存及限时取消；`shared/agent-material-plan.test.ts`验证合成姓名、法院/金额/日期保留、号码/地址、文书边界和合并单元格。这些测试不证明真实卷宗无脱敏遗漏，真实运行须另外记录时长、来源覆盖、主体及文书分界。

### 已发布结果的程序复核

`POST /api/material-library/redactions/:id/revalidate`仅适用于程序Agent产物。它按当前编译器读取同一私有输入/计划，将复核追加到处理job的`result_summary.latest_program_validation`与历史数组；`library_redactions`产物行保持不可变，原任务status不改。读取可用版本、加载及新建题目同时排除显式复核失败的结果；旧题冻结快照不切换。缺少私有证据时不能宣称重新验证成功。显式续作可引用同包同集合已成功的redact任务，复用同输入/模板/模型检查点并生成新结果，不覆盖旧版。

身份及边界疑点必须给出本次真实字段或结构块ID，不接受all等整包概述。非阻断身份疑点必须已有对应化名或原有遮盖；无法确认身份对应不构成保留原名的理由。Agent工作区的`review-hints.json`仅是程序根据角色/标题定位的阅读导航，不能当作身份判断、边界结论或材料份数目标。

Agent返回计划后，编译器调用`shared/scan-noise.ts`的统一正则规则，将固定OCR占位符、独立数字行和扫描时间戳清理合并入精确原文编辑，随后重新计算分册范围并校验完整覆盖。表格/列表值、金额/编号标签后的数值及已提交遮盖映射的编号不按数字垃圾删除；普通业务日期保留。规则与边界唯一说明见`shared/README.md`。清理可能使分册片段只剩换行，prepared-structure保留其精确覆盖，DOCX渲染跳过空段。API遮挡流程在AI映射返回后调用同一结构清理方法。既有发布结果和题目快照不追溯改写；现有材料修复须生成新版本。
