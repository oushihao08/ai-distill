<!-- 文件职责：说明全局材料库的存储、处理配置、API、任务、项目加载与文件阅读。 -->

当前执行绑定以项目、题目、任务、材料包、revision和附件ID为准。已派发任务不再因正文/配置/提示词/整理结果的内容摘要或环境指纹变化而被拒绝；保留任务取消、最新任务归属、材料集合完整性、结构格式和路径边界检查。摘要字段仍用于历史记录、内容寻址及缓存，不作为上述业务执行前后的版本准入门槛。本段覆盖下文历史指纹绑定描述。

# 独立材料库

提取发布（含MinerU桌面结果导入）通过`storeExtractedDocument()`显式启用共用英文整段过滤：至少两个英文单词、以英文句末标点结束且不含数字/中文的完整英文说明段清空；数字、网址、邮箱、编号、单位及中英混排保留，不按任意无中文字段删除；表格逐单元格、列表逐项处理，ID、页序及合并关系保留。删除沿用原始OCR副本和精确坐标审计；结构与正文投影同步发布。历史结果不回写，已有成功任务不自动重跑。Agent计划编译的默认扫描噪声规则不因此扩大。

本模块管理不属于任何项目的材料包和不可变文件集合。同一包可加载到多个项目（包括既有 legacy 项目）。期次出题设置默认选择成功脱敏版本，也可选择已完成 MinerU 提取的原文版本；题目级 `question_library_sources` 冻结来源模式、版本与正文/索引，后续出题、作答、评分和交付均按该快照读取。原文模式只发送已提取文本与结构，不发送原始二进制。未绑定共享库快照的旧题继续走原步骤 1/9，旧目录建题流程仍只支持脱敏；共享材料快照题可用于新旧项目，项目 `material_backend` 不因此改变。入库/提取/脱敏不创建旧材料包工作流，也不向 legacy 材料表写库级原件。

## 模块与存储

| 文件 | 职责 |
| --- | --- |
| `storage.ts` | 原件内容寻址安装、同摘要事务锁、确认回滚后的本次无引用文件回收及受管路径/摘要校验；文本入口共用`insertLibraryTextBlob()`核对正文/MIME/UTF8字节数 |
| `service.ts` | 包资料、不可变文件集合、上传幂等、逻辑归档/恢复、历史与使用查询；复用原件时核验字节摘要与大小，只修复不可变文件对象的受管存储路径 |
| `settings.ts` | 共用SQLite配置数据库；首次读取初始化并持久化默认模板，每次派发重新读取；乐观版本控制、事务保存，不保存密钥 |
| `jobs.ts` | 入队时读取共用设置并冻结；请求重放、执行lane、租约、取消、失租和终态事务 |
| `runner.ts` | 领取后的调度、心跳、取消与截止；入库和提取执行；`executeExtraction`/`runClaimedJob`支持隔离行为验证 |
| `extraction-checkpoint.ts` | 私有单文件检查点读写；同版本显式重试可复用，异常降级继续，不发布或派发任务 |
| `redaction-runner.ts` | 仅按冻结Agent模板执行整包化名并事务发布；旧字段映射快照在读取正文前拒绝 |
| `execution-shared.ts` | 执行器共用摘要、私有目录、提取结构校验及正文发布前保守清理；有改动时同时保留原始OCR对象与精确编辑审计 |
| `processing-policy.ts` | 从期次配置读取当前两模式及历史mask身份并约束派发模板；不调用模型 |
| `agent-redaction.ts` | 单次限时Agent调用及最终程序编译；不入队、不自动重试 |
| `agent-redaction-artifacts.ts` | 私有输入、同源检查点、固定结果文件及本地校验工具准备 |
| `agent-redaction-validator.ts` | 打包到任务内的只读校验CLI，供Agent在同次调用内修正错误；不写库 |
| `redaction-review.ts` | 显式复核Agent已发布产物，将当前结论及历史追加到job.result_summary，不改不可变产物或任务成功历史 |
| `preparation.ts` | 可跳过的材料整理任务：按冻结的提取/脱敏来源生成总摘要、逐份摘要、文书可见性和支持范围；对首轮未覆盖或无摘要材料按有限批次补摘要，原文保留在材料库及人工预览 |
| `worker-once.ts` | 验收入口，只消费HTTP已创建的指定本机Agent材料job UUID，复用共享Agent槽位与正式事务，不领取其他任务 |
| `prepared-import.ts` | 导入Codex已审阅的原文编辑/分册计划：校验完整提取来源、精确编辑、范围覆盖与请求幂等，在同一事务保存新任务及脱敏结果；不OCR、不调用模型、不改旧结果 |
| `mineru-import.ts` | 导入MinerU桌面端content_list：核对完整版本原件摘要与PDF页数，复用结构转换，事务保存提取文档与来源摘要；不重跑OCR、不脱敏 |
| `preview.ts` | 按文件/成功提取任务/成功脱敏结果身份按需读取正文，校验摘要；单文件脱敏通过索引定位，拒绝任意blob读取 |
| `original-preview.ts` | PDF/TXT等原件直接查看，DOCX由隔离LibreOffice生成只读PDF副本；串行转换、60秒时限、按源摘要和渲染版本缓存 |
| `projects.ts`、`questions.ts` | 项目加载与选版/移除；按期次所选模式从脱敏结果或 MinerU 提取版本建立完整题目私有快照 |
| `projects-routes.ts`、`uses.ts` | 本期材料候选分页、加载引用/恢复、题目创建入口及本期使用状态/单条事件读取 |
| `atomic-import.ts` | 独立上传任务、暂存文件及整包提取后的原子发布；成功前不建立正式包/版本，复用现有执行队列和槽位 |
| `routes.ts` | `/api/material-library` 的资料、版本、任务、配置、预览和使用关系接口 |
| `legacy-import.test.ts` | 旧包原件/成功提取导入的页序、摘要、状态与原期使用关系校验；不测试脱敏或修改旧题 |
| `projects-routes.test.ts` | 候选分页与并行读取、已移除引用恢复及单条使用事件路由边界 |
| `uses.test.ts` | 原件集合身份、跨期占用、原期返修、提交证据和事件摘要边界 |

原件位于`<STORAGE_DIR>/material-library/blobs/`；共用处理设置位于同目录下私有`processing-settings.sqlite3`；DOCX预览缓存位于`previews/`，转换临时目录和用户profile使用后删除。所有SQLite配置供同一STORAGE_DIR的本机API实例共用；未承诺多台独立API自动同步本地配置。worker读取已冻结的PostgreSQL任务快照，不在执行中重新读取本地共用配置。

普通提取和MinerU桌面导入在发布`library_documents`前共同调用`storeExtractedDocument()`，复用脱敏后的`cleanScanNoisePages()`。只处理确定扫描水印、OCR占位标记、有跨页证据的页角码及确定的格式转义；不自动删除普通数字、业务日期、含义不明的符号或“乱码”。页、块、表格和列表结构不删除。发生修改时，原始OCR以不可变文本对象保存，正文对象的`cleanup`记录原始对象ID、摘要及每处原文坐标/替换；无改动不增加原始副本。发布正文和`text_sha256`按清理结果一致计算，原文件字节、摘要及OCR issues保留。此行为只作用于新提取发布，不回写旧结果；原文模式的新题也使用该确定清理后的提取正文。

Agent只须提交`output/material-plan.json`，包含主体、编辑、文书和未决项；分项进度文件可选。程序生成私有对应表和精确坐标，恢复时复用同源计划。语义编辑`credential`用于验证码/密码全遮；地址`keep_prefix`可为空，表示无法确认行政区划而全遮地址片段。业务提示词来自本次冻结模板；运行器仅追加文件位置、Schema及校验命令，不再次复制业务规则。模板更新不改变已冻结任务，源码修改须由重新启动的服务加载。

文件对象的摘要、大小、MIME、存储目标和类型保持不可变；在上传端已核验完全相同的字节并写入受管路径后，允许修复该文件对象的`storage_path`定位值。数据库迁移`049_allow_verified_library_blob_path_repair.sql`仅开放此单字段更新，不开放文件对象删除或其他字段修改。

Agent本地校验器打包为Node兼容ESM；Windows使用`node --preserve-symlinks-main --preserve-symlinks validate-plan.mjs`，避免MXC默认拒绝读取父目录时运行时真实路径探测失败。其他平台继续使用`bun validate-plan.mjs`。调用命令由程序提供，不修改数据库中的业务脱敏规则。

包名称/说明/标签与处理设置分开。历史`library_packages.processing_settings`保留兼容初始快照，不再作为新任务执行配置，也不从包详情返回；包创建/更新接口拒绝单包处理配置写入。未保存共用配置时，从数据库系统提示词与当前系统模型/提取默认组合完整配置。保存后的共用设置只影响之后派发的新任务，历史任务与题目快照不回写。

新默认`extraction.provider_config`为空兼容对象；既有旧Vision配置可读，不自动删除已保存设置，但MinerU不执行这些字段。实际供应商由任务`pdf_provider`冻结，转换语义由源码版本标识约束；调整未来有效提取配置时须同时更新检查点身份，不能把“当前未使用”推广为永远可忽略。

PDF/DOCX提取任务的冻结执行预算至少为65分钟，使PDF在MinerU API的30分钟时限后还有一次最多30分钟的CLI回退及处理余量；纯文本提取和脱敏任务仍按共用设置执行，Agent整包脱敏沿用冻结执行预算，不再另设10分钟上限。该预算是整包总时限，多文件处理仍可能因供应商慢而失败。

## 期次两种处理模式

设置权威字段是出题步骤（ordinal 4）JSON配置中的`material_processing_mode`；由现有步骤设置API持久化，UI/CLI共用，不由Skill或提示词决定。`GET /api/projects/:id/material-processing`读取实际模式。旧`material_source_mode=original`兼容原文；无设置默认`aliases`。

| 值 | 处理入口 | 建题及后续来源 |
| --- | --- | --- |
| `original` | 成功入库/提取后不派发脱敏 | 冻结提取原文与结构；出题、作答、评分、交付共用该快照 |
历史`mask`只保留读取和既有冻结来源；新保存、新任务拒绝旧遮挡，不自动解释为aliases。
| `aliases`（默认） | 带`project_id`派发任务，程序选择整包化名模板，当前由本机Agent执行 | 仅选择化名整理结果，冻结为redacted |

材料任务请求可带`project_id`：服务端从该期次配置选流程，拒绝不一致的客户端模板，原文模式不派脱敏；新任务冻结模式及处理配置，历史任务不切换。未带项目上下文的全局库操作仍可显式选择模板，供不同项目共享已处理版本。旧字段映射模型配置不再用于派发或执行。化名方法与执行适配器分离：当前接`runAgent`，未来API Agent后端可实现同一任务/结果接口，尚未宣称该后端已实现。

本期可先加载已提取、尚待脱敏的材料，点击“处理材料”进入带期次上下文的材料页。处理成功后选择匹配版本再建题；不恢复通用自动推进。改变本期模式只影响新题；既有题目依然按题目快照执行，禁止作答/评分临时重读当前模式并切换材料。成功消息或阶段文件不等于发布成功：以library_jobs.succeeded和library_redactions可读结果为准。

## 页面与接口

化名脱敏的`POST /revisions/:id/jobs`请求可显式提供`agent_settings:{model,reasoning_effort}`，仅覆盖该次任务并参与幂等摘要及配置冻结；省略时读取共用处理设置中`redaction`的Agent模型和强度，所有项目使用同一默认，不读取项目Agent默认。仅历史共用配置仍为API格式、缺少Agent模型时回退系统Agent默认。单次覆盖不保存回共用、系统或项目设置。只允许用于redact任务，模型真实可用性以本机Codex调用为准。模型改变会使原有同模型检查点失配，保留previous_job_id追溯，但重新审阅整包建立计划。

`POST /revisions/:id/mineru-extractions` 导入本机已入库PDF的MinerU桌面端提取结果，不重新OCR。JSON为`{request_key,files:[{file_id,source_sha256,page_count,content_list}]}`，必须完整覆盖版本所有文件；`content_list`使用带`page_idx`的`*_content_list.json`或逐页数组，不能传`layout.json`。程序复用MinerU结构转换器，验证原件摘要、大小、PDF真实页数和可处理正文，在同一事务保存成功extract任务和全部library_documents；保留OCR issues并标明`mineru-desktop`及`model_invoked:false`。相同请求键和内容返回原任务，内容改变需新键；活动任务期间拒绝导入。来源对应是用户提供的桌面结果与原件配对声明，摘要/页数校验不证明OCR逐字准确。导入后复用现有Codex化名、分册、建题和DOCX链路，不更改期次来源设置或旧题。

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

正文预览上限4MiB，超过时明确拒绝而不是截断。脱敏预览的`metadata_only=true`只返回来源和校验信息，供按绑定提取任务列出全部文件；带`file_id`时按单文件返回正文并限制大小，内部整包索引只做摘要校验，不按其大小误拒单文件预览。原件PDF按原字节返回；DOCX缓存最大32MiB，缺转换器、超时或转换失败显示可操作错误。macOS的部分headless发行版遗漏当前系统字体资源路径，会出现可复制但不可见的中文；转换只在私有临时fontconfig中补入系统字体目录，不安装或修改全局字体。

任务详情只投影身份、状态、计数、安全错误、previous_job_id、extraction_job_id、cancel_requested_at；不返回input/config快照。取消排队任务同步终止，运行任务等待执行器结束；失租不退回排队。重试新建任务并保留来源，使用新的共用配置。旧缺少冻结PDF供应商的任务不能默默改用新环境，需新尝试。

## 验证与维护边界

脱敏派发、执行及建题来源复制前共用 `assertLibraryExtractionUsable()` 检查文件、页数和正文可处理性；整个文件无正文时在模型调用前明确拒绝，空白页随有正文的其余页保留。OCR issues 是识别提示，不能等同于脱敏丢失内容，不再仅凭提示数量阻断脱敏或建题。提示保留在提取文档、脱敏索引及 validation_report.extraction_issues 中，原件摘要、页/字段覆盖及原文定位仍校验。脱敏验收比较已提取原文与脱敏正文的实质内容，允许正常遮盖及无实质影响的格式差异；usable_for_question 表示输入和脱敏产物可用于建题，不证明原PDF逐字OCR准确。此政策不回写历史任务/产物。

以下文件是源码级替身测试，不连接真实 OCR、脱敏模型或外部平台；具体检查边界如下：`storage.test.ts`验证原件内容寻址、字节重校验和文件名边界；`service.test.ts`验证资料过滤/版本、逻辑归档恢复及使用历史投影；`jobs.test.ts`验证提取/脱敏来源校验、执行lane、取消、失租和晚到结果；`projects.test.ts`验证加载关系和选版；`projects-routes.test.ts`验证候选分页、恢复和按单条读取事件；`questions.test.ts`验证题目字段、摘要和脱敏/原文快照；`preview.test.ts`验证正文摘要与文件身份限制；`legacy-import.test.ts`验证旧数据导入不伪装提取/脱敏结果并保留原期关系；`uses.test.ts`验证材料使用签名和跨期/返修状态边界。测试文件存在不代表本轮已运行，也不证明真实 OCR/脱敏质量。

数据库是否具备所需迁移必须查询目标环境，不能由本说明推断。历史检查只证明其记录的时间、输入和范围，不代表当前环境或真实模型质量已验收。

文件系统与PostgreSQL不是同一原子事务；提交未知时保留对象并按幂等key核对，不因单请求失败清理可能已被引用的blob。旧流程保留，不迁移或清理旧业务数据。

原件安装器的临时硬链接清理失败只记录安全告警，不覆盖安装异常；安装成功时仍执行正式文件路径/内容校验并返回installed_new回执，使后续回滚能够核查回收。遗留临时链接不代表原件已登记，本流程不自动扫描删除它们。

普通上传和历史导入在安装前按摘要排序取得同一组事务锁，持有到登记/提交结束。仅当ROLLBACK成功后，回收器重新取得相同锁并查询是否存在任一执行目标的file blob登记；只对本次installed_new=true、查证无登记且路径/类型/摘要/大小一致的原件删除。复用文件、已有登记、回滚未知、核查失败或锁等待超限均保留；回收事务锁等待2秒、语句10秒，不自动重试，也不覆盖原上传错误。COMMIT回执丢失但实际已提交时，登记存在会保留文件。installed_new是临时安装回执，不持久化到blob身份；本轮没有目录扫描、历史回收或业务数据删除。所有共享同一存储的原件写入口须一起加载新代码；SQL替身验证不等于真实PG锁竞争或实体多进程验收。

材料包列表支持 `q`、重复的 `project_id`、`redaction_state=all|ready|not_ready`、`preparation_state=all|ready|not_ready` 组合筛选，筛选在分页之前执行。项目多选取当前有效加载关系的并集，忽略移除关系及已删除项目；脱敏状态按是否存在成功且可用于建题的版本判断，兼容原 `ready_only` 参数。整理筛选只统计当前文件版本已发布且任务成功的整理结果，不把旧文件版本、排队或失败任务计为已整理；整理表尚未启用时已整理为空、未整理为全部。`GET /api/material-library/project-options` 提供未删除项目的轻量选项。


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
| 整包化名模板（默认） | Agent消费池 → 语义计划编译 → 既有结果事务 | 人名保留姓氏、名字同音或近音换字；单位字号谐音替换，类型/行业/组织形式保留；法院保留、精确编辑与结构分册；按冻结执行预算，私有进度保留 |
| 原文建题 | 成功提取版本 → `createLibraryQuestion()` | 冻结`original`来源；可不脱敏 |
| 脱敏建题 | 与本期处理模式一致的成功脱敏结果 → `createLibraryQuestion()` | 冻结`redacted`来源；下游不再选择模板 |

CLI与HTTP的计划入口共用`shared/material-preparation.ts`的`validateMaterialPreparationPlan()`；随后按具体来源校验精确编辑、结构和全文覆盖。没有模板字段的旧计划继续兼容；显式模板必须同时提供有效`template_id/template_digest`，空值不能当作旧计划处理。

旧文本计划只产出编辑后文字，由导入入口构建明确的段落结构；不沿用编辑前的表格/段落对象。整包模板计划才通过结构编辑器生成编辑后结构，避免正文与旧结构不一致，也避免把旧文本计划冒记成保留原结构。

模板与材料包、项目身份分开。`GET /redaction-templates`读取模板提示词、workflow及digest；目录仅列当前Agent模板；旧mask模板解析和字段映射执行已删除，显式mask不再存在于模板目录；读取旧共用设置时只读过滤旧模板，不回写SQLite，显式保存仅接受Agent模板。省略模板时使用aliases。共用设置可保存最多20项`redaction_templates`，每项id/name/prompt独立，workflow固定codex_plan；新安装或已保存空数组时提供内置Codex整包模板；不保存密钥。

旧`mask/field_mapping`冻结任务也不再执行或复用模型结果，执行入口明确拒绝，需重新创建Agent化名任务；数据库历史结果只读展示及其原身份保留，不删除业务数据。
- `codex_plan`：默认aliases模板，省略template_id也选择它。每次入队读取共用SQLite配置数据库中的提示词并冻结模板及系统Agent模型；默认由既有Agent消费池整包执行；显式api_settings使用API消费池，均不调用旧字段映射引擎。`shared/agent-material-plan.ts`将完整ID/文本结果与结构块范围编译为既有精确计划，再做无重叠/全文覆盖/结构校验。冻结原结构、ID文本结果和阶段进度保留在`jobs/<job-id>/private/`（700/600），不进入题目或交付。任务领取后沿用冻结预算生成deadline，截止停止子进程并以agent_redaction_timeout终结，不自动重试。显式重试只复用同输入/模板/模型的私有进度。人工CLI精确计划导入仍须绑定template_id/template_digest，保留原幂等行为。

模板计划沿原提取structure应用字段内编辑，保留行列和rowSpan/columnSpan。跨字段编辑、切断表格或列表、正文覆盖/结构投影不一致均拒绝；原始结构缺失不得静默回退。CLI原文单文件返回structure和field_ranges供定位。索引prepared_documents包含分册document，供通用材料DOCX和Work五件套共用；旧文本型分册仍走兼容渲染。结构保留不等于原始OCR结构准确，须渲染核查异常表格。

新结果不自动选入项目或修改旧题；新题按已有来源快照机制冻结具体结果。无需新增表迁移；模板提示词保存在本机SQLite，期次处理模式保存在PostgreSQL的project_step_configs.config.material_processing_mode；题目、答案、评分与归档不自行选择模板。

历史导入曾将 PDF 的识别类别 `scanned`／`text` 写入原件 MIME。再次上传相同 PDF 时，入口在文件签名、SHA、大小和受管路径一致后，仅兼容这两种历史类别并复用不可变对象；其他类型冲突仍拒绝，不改原件字节或题目快照。

同字节的TXT/MD可以复用一个原件对象，文件集合仍保留各自文件名、位置与脱敏声明；复用不改旧对象MIME，也不放宽PDF/DOCX等二进制类型冲突。提取时以本次文件名确定TXT/MD解析路径。

## Agent材料执行与验收

### 可选API执行后端

`aliases/codex_plan`表示化名方法和计划协议，不等于固定模型后端。默认读取共用脱敏Agent设置，优先级及历史回退见上文；新建redact任务可显式传`api_settings: ModelApiConfig`，与`agent_settings`互斥，完整非敏感配置进入请求幂等摘要和冻结快照，使用现有API消费池。未指定时不使用通用API默认值替代Agent。不修改共用默认设置或历史结果。

`agent-redaction.ts`维护共用输入准备、预算、检查点身份、最终编译和私有产物。`api-redaction.ts`只适配模型调用：将同一source/schema/提示词和可用续作计划内联给`llm-api`；宿主执行同一`compileAgentTextMaterialPlan()`，反馈校验错误供模型在剩余预算内修正。API没有本地shell/读文件能力，不把工具脚本作为可执行提示发给模型；供应商失败不自动重试，相同无效计划停止。API配置参与检查点指纹，不能混用Agent检查点。结果沿原redaction-runner事务发布，不新增一套脱敏处理链。

此能力当前通过HTTP任务参数选择，未增加页面选择器或CLI快捷参数。源码和单元测试不代表已运行服务加载；八包真实对照只在本地生成产物，不验收业务库发布，见`执行观察/api-aliases-20261027/对比报告.md`。

文本协议固定为`id-text-v2`，常量、schema和编译器以`shared/agent-material-plan.ts`为准。`source.json`的texts按阅读顺序只包含`{id,text}`：每个段落、列表项、表格单元格、表题或脚注分别定位。文本ID为“文件/页作用域＋原块ID#字段路径”，例如`f1p1/b0-1#text`；单元格使用`#rows/0/cells/0/text`，列表项使用`#items/0`。有效原块ID不再重编号；原ID缺失或重复时，仅定位键使用冻结块位置补充区分，原结构ID不改写。字段坐标由当前块直接枚举，不按原块ID反查，也不以正文作为身份键。同文不同ID仍是不同位置。模型返回完整同ID文本列表、文书首尾块范围及疑点；未修改字段原样返回，明确删除返回空字符串，原空字段保持空字符串。模型结合整包上下文统一化名和处理敏感片段，程序保留原页、标题层级及表格合并关系，按ID回填并生成实际变化区间的精确坐标，避免把整个字段均标成变化。分册范围通过块索引定位，坐标偏移按页累计并二分查询。

Codex、API、本地校验器与宿主发布前统一调用`compileAgentTextMaterialPlan()`，拒绝旧entities/edits结果、混合格式、未知/重复/缺失ID。旧entities/edits计划和v1位置ID结果通过`compileAgentMaterialPlan()`只读重验，不能冒充新任务结果；历史结构若原块ID重复且无法证明旧映射无歧义，明确拒绝重验。旧协议或未冻结协议的待执行任务须显式新建，不自动调用模型转换。重复扫描按冻结模板保留并关联。成功结果继续进入`library_redactions`及`prepared_documents`/题目快照链路，不增加表迁移或改变DOCX结构契约。

新派发的`config_snapshot.text_protocol`、私有校验上下文、正文索引和验证报告均记录文本协议；续作指纹绑定协议、原结构摘要、来源、模板、模型及后端，仅复制匹配的`material-plan.json`和`progress.json`。旧协议或缺少标识的检查点不复用。已有外部调用缓存不换键重调；缺少新协议标识的缓存拒绝发布，须显式新建任务。新契约不再要求模型返回主体映射表，`entity_count`为null表示未统计，不作为零主体。结构/ID通过不代表脱敏零遗漏，也不改变现有unresolved的技术发布语义。

边界不清的连续附件可完整保留为组合文书；身份归并不明时不强行合并，分别处理对应字段文本并记录疑点。未确认的归并或精确分册写私有非阻断疑点；隐私处理仍由本次冻结模板指导Agent；unresolved保留原始语义标记，不作为技术发布否决。正文无法完整覆盖仍阻断。

Agent完整语义计划交付到固定私有文件`output/material-plan.json`（结构见任务内`plan-schema.json`），最终消息仅声明`plan_file`；执行器在Agent正常完成后读取该文件并编译发布。阶段文件或成功消息本身不等于发布完成；最终路径声明错误以`agent_plan_file_declaration_invalid`记录，声明正确但文件不存在以`agent_plan_file_missing`记录，空计划和源文覆盖缺失仍分别报告对应校验错误。不从聊天摘要补造正文，也不要求模型再在最终消息重复整份大JSON。

私有`validate-plan.mjs`在编辑重叠时同时输出`validation_details`，包含冲突字段ID、零起始计划编辑或主体/变体序号及字段内坐标，帮助Agent修正具体条目；不输出原文，不自动删除冲突编辑或放宽校验。标题内容由Agent按本次模板生成，工具及宿主共用的编译器不检查标题是否包含主体原称或敏感号码；显示标题与安全文件名分离，结构及覆盖校验保留。

编译器不再按标签/正则猜测姓名、号码及地址残留并否决发布。续作仅复制同源计划和进度，不再复制已停用的残留匹配反馈；旧私有记录保留原样。精确编辑、来源、结构和覆盖仍验证。

`agent-redaction.test.ts`和`api-redaction.test.ts`以注入执行器验证新ID文本输入、生成校验器、同源续作、API修正及正常发布事务；不调用真实模型或业务数据库。`shared/agent-text-material-plan.test.ts`覆盖重复/缺失原块ID、跨文件隔离、空表格行、合并单元格、长度变化和非法返回ID；`shared/agent-material-plan.test.ts`保留历史主体/编辑计划基线。真实模型语义质量与服务运行情况须单独核实。

### 已发布结果的程序复核

`POST /api/material-library/redactions/:id/revalidate`仅适用于程序Agent产物。它按当前编译器读取同一私有输入/计划，将复核追加到处理job的`result_summary.latest_program_validation`与历史数组；`library_redactions`产物行保持不可变，原任务status不改。读取可用版本、加载及新建题目同时排除显式复核失败的结果；旧题冻结快照不切换。缺少私有证据时不能宣称重新验证成功。显式续作可引用同包同集合已成功的redact任务，复用同输入/模板/模型检查点并生成新结果，不覆盖旧版。

身份和边界疑点作为私有说明保存，blocking标记、说明定位或缺少化名映射不单独阻止技术发布。真正的编辑和分册仍须定位有效原文字段/结构块。review-hints.json仅作阅读导航。

材料文本的HTML/XML、实体及文字转义残留统一由`shared/material-markup.ts`生成局部编辑，并由`scan-noise`在提取发布与脱敏计划编译中应用：标签外壳移除，标签内文字保留，多层实体还原；法规名称与比较符号保留。它不改DOCX、不整字段覆盖已应用的化名/号码遮盖，原始OCR及清理审计沿原发布机制保存。

Agent返回计划后，编译器调用`shared/scan-noise.ts`的统一正则规则，将固定OCR占位符、扫描时间戳及有扫描/跨页证据的页角码清理合并入精确原文编辑，随后重新计算分册范围并校验完整覆盖。普通独立数字行保留；前一非空块明确为金额、数量、编号等短业务标签时，扫描号或跨页证据也不能据此删除其数值。此保护不覆盖全部业务语义。表格/列表不参与页角数字推断，已提交编辑覆盖的纯数字候选不重复清理。技术校验不证明所有业务数字均已语义核验。规则与边界唯一说明见`shared/README.md`。清理可能使分册片段只剩换行，prepared-structure保留其精确覆盖，DOCX渲染跳过空段。旧API字段映射执行已删除。既有发布结果和题目快照不追溯改写；现有材料修复须生成新版本。


## 停止、原因与提取续作

库runner将同一个本任务AbortSignal绑定到withTaskSignal上下文，网络、Poppler及解压共用取消；已领取但尚未开始的job在worker停止后不调用供应商。任务截止以领取时冻结的deadline为准，不自动续期。finishLibraryJob在发布事务的关键边界检查本任务取消，仍保留取消标记、租约和截止的数据库条件，未完整发布的结果不能进入加载/脱敏/出题。

新任务停止原因写入`result_summary.execution_stop`，保留其他摘要；用户取消和worker停机仍为cancelled，超时、心跳不可用与失租按失败/提交权处理。cancelled.error_code继续为null，数据库cancel_requested_at在终态竞争时优先；历史没有该元数据时不推断取消原因。更新未命中当前租约时只报告终态未写入，不覆盖新owner，也不宣称已经改成失败。提交回执出错后若按同job确认已经succeeded，不再次补写失败。

新库提取每个文件完成后在`<STORAGE_DIR>/material-library/jobs/<job UUID>/extraction/<file UUID>.json`原子保存私有检查点（目录0700/文件0600），记录来源/输入清单/版本、实际提取条件、结构、issues和实际provider。v2身份绑定原件、版本清单、PDF冻结供应商/DOCX固定API/文本本地解析及对应转换版本；脱敏模型/提示词/模板、旧provider_config和调度预算不参与复用身份，完整任务配置仍保留。旧无version检查点继续按整份config_digest保守核验，不从旧摘要推断新身份或改写历史。仅显式previous_job_id重试按同一身份验证后复用；request-key变化本身不影响复用。损坏、不匹配、缺失、不可读或不可写检查点都降级为正常提取/继续，不为辅助缓存阻断任务。历史无检查点正常运行，不读取旧工作流ordinal缓存。

每次命中的检查点写成本job进度，仍由原事务整包发布；单个PDF尚在供应商处理中时不支持页级续算或接管远端batch。成功清理本job私有临时目录，失败检查点保留到显式续作；人工清理须先确认job无活动执行，只清理指定job目录，不删除原件或其他尝试。检查点可能含未脱敏正文，不作为公开产物和日志字段。

`extraction-recovery.test.ts`使用临时存储、假提取器和SQL替身覆盖多文件恢复、缓存降级、权限/来源不匹配和停止分类；不证明真实PostgreSQL事务或MinerU质量。本轮变更不自动启动服务或恢复业务批次。

本模块local队列模式的派发归属、指定ID领取、取消及恢复接入共享[执行队列](../execution-queue/README.md)；业务输入/结果契约保留，默认兼容模式不代表业务环境已切换。

材料失败结算的local恢复：处理器判明失败后先持久化安全终态与原租约，再写PG。暂时写入失败保留result_pending_commit；恢复仅调用原失败结算，不再读取原件或调用处理器。仍核对原租约及取消优先级；未知失败不按日志猜测重放，详见[执行队列](../execution-queue/README.md)。

任务详情在local模式为queued/running结果附加execution投影，按PG归属及代次核对本机队列；业务status原值保留。待核实不伪造失败、不自动重试；终态不附加旧执行投影。

### 取消语义门禁后的成功边界

Agent自检、宿主发布及显式复核共用同一编译器。成功表示原件与来源、精确编辑、结构及全文覆盖满足执行契约，不表示独立隐私审查通过。既有失败/复核记录不自动改写；新结果按新编译器生成，旧结果需显式复核或新尝试。标题可包含冒号或较长文字，文件输出使用净化并带序号的名称，不以标题格式否决整包。跨文件文书仍逐块保留来源和完整覆盖。

任务入队冻结共用execution.task_timeout_ms；领取生成deadline，runner和Agent按剩余预算执行，不再多层夹断到固定10分钟。取消、心跳、租约和发布期限保持。单任务worker复用此期限，不另起固定10分钟终止器；排队等待仍服从并发槽位。

生命周期回调由[同步增强层](../lifecycle/README.md)统一注册，事件接入现有执行/保存边界；无注册时保持原流程。

## 项目生命周期隔离

全局入库、提取、脱敏保持通用处理，无项目上下文时不套用某个项目规则。建题事务取得原锁后调用`lifecycle/steps.ts`的materialQuestion策略；Work一包一题由`lifecycle/projects/work.ts`注册，其他项目默认无此限制。原singleQuestionPerPackage导出保留为策略兼容门面，不再自行判断项目名称。材料占用账、快照、版本及事务约束不迁入项目策略。

本机明确新派发可在同一事务替代他机尚未开始的同范围待办；运行、结果未知和续作仍受保护，新派发失败则旧意图变更回滚。适用范围、共享状态兼容与验证边界见[执行队列的跨机准入](../execution-queue/README.md#他机未开始待办与本机明确派发)。

## 材料整理与使用范围

`preparation.ts`复用`library_jobs(kind=prepare)`及本机Agent槽位，读取成功提取或脱敏结构，单次Agent读取固定目录与正文，一次返回逐份描述、可见性、总摘要与组合；规则直接内联，不再读取scene-rules.md，不自动补调，保存材料包总摘要、每份材料摘要/类型/标签，以及多组由材料支持的方向、主体/立场、相容场景/时点、核心工作和多项交付。整理不作默认选择、不裁剪材料，也不增加步骤编号或前置审批；缺失、失败或摘要不完整时，原建题流程继续。prepare不参与提取/脱敏的revision互斥；仍共享现有Agent容量，默认不自动派发。

HTTP：`POST /api/material-library/revisions/:id/prepare`接收`request_key`、`redaction_id`或`extraction_job_id`，可选`project_id`及`agent_settings`；`GET /api/material-library/packages/:id/preparations`列出最近结果，`GET /api/material-library/preparations/:id?include_content=true`读取完整文书。状态和取消沿用jobs接口。同请求键恢复原ID；同来源/项目/模型及规则的成功结果或本机在途整理复用；成功结果可只读复用，不认领他机在途任务。新任务按来源目录固定材料ID、标题、顺序及全部结构块，Agent只返回描述信息，不接收重分册的块ID或标题。已有脱敏分册直接沿用；未分册原文按原文件保留，不在整理阶段拆合。缺摘要只针对相同材料ID补描述，不新增材料。边界疑点记入notes，交回上游处理；未知或重复描述不替换来源正文，未补出的摘要留空提示，不阻断建题；模型结果未知不自动重调。

总摘要由Agent根据最终目录、逐份描述及原文概括法律关系、材料构成、主要事实和程序状态，不写整理数量或处理进度；数量由程序计算。单次调用使用本次deadline及完整响应检查点。组合须明确主体、工作、信息时点、交付用途及可见依据；分别处理事件、凭证申请、取得及送达时间，时间不明时注明阶段或适用条件，不猜精确时点。多组选用须同一服务主体、案件与工作关联、场景相容；程序只核验字段和可见引用，不将结构校验冒充语义审查或增加整包准入门槛。

建题POST不接受候选或文书筛选参数。服务端按材料包、revision、脱敏/提取来源摘要及项目自动匹配成功整理；匹配后将摘要、支持范围和可见性冻结到题目来源快照。人工材料预览仍可读取全文；标为隐藏的文书不会发送给出题或作答模型，也不会进入材料DOCX。出题、作答使用相同的可见正文投影；评分使用本轮作答冻结的同一材料输入。合并DOCX按整理出的文书边界拼接可见份数，并复用正文已有的同名首标题；若整理结果存在但没有可见文书，拒绝导出，不回退到全文。整理缺失的历史题维持原来源行为。

隐藏只针对正文已完成出题目标中同类交付成果的文书，例如已写好的证据证明目的说明、庭审提纲、答辩意见、金额核对表或后续申请意见；理由须说明对应成果。判决、裁定、执行记录和其他事实/法律依据正常可见，不因包含结论或后续结果而隐藏。首次整理与补摘要共用这一规则和本次场景规则。实际OCR疑点或材料冲突记入逐份`notes`；`warnings`仅由编译器记录摘要缺失、结构/组合引用无效等实际问题，不采纳模型的正常过程或功能说明作为警告。新规则不回写历史整理结果或题目快照。

新整理结果的`document_count`只数完整文书；未归类分组及其结构块单独计数。来源已有类别时沿用，否则Agent只判断现有整条记录的类别，不改变边界；空白、残片、无法确认完整文书或未分册合订文件按未归类保留，全空记录由程序排除完整文书计数。旧结果没有`unit_kind`，其`documents.length`只是整理记录条数，不能当作真实文书份数；详情会显示记录条数、摘要非空数和真实份数未知。出题Agent实际采用的方向、主体、场景及`deliverables`保存在`step_attempts.result.material_scope_selection`（步骤投影也返回该字段）；主组合与`additional_combinations`附加组合均保存在该JSON中；历史单组合仍兼容。`question_material_scope_uses`只保留方向+场景参考索引，冲突不阻断题目保存；每题实际交付以尝试JSON为准。无需新增数据库列或迁移。无法可靠解析的历史题不自动回填；整理结果需要051；053参考索引缺失不阻断整理上下文冻结或出题保存。旧题快照不追溯改变。

`preparation.test.ts`以SQL/Agent替身和临时文件验证摘要编译、材料完整性、作者输入和组合重复登记；不证明真实Agent分析质量或业务环境已经迁移。CLI语法见[CLI说明](../../cli/README.md#可选材料整理)。

### 整理显式恢复与预算

prepare请求可带`execution_timeout_ms`（1000至86400000毫秒，默认30分钟），只冻结本次预算，prepare领取任务时不再被通用30分钟上限二次截短。`POST /api/material-library/jobs/:id/prepare-resume`接收新`request_key`和可选预算，只允许失败/取消的prepare，继承来源、项目和模型，创建新job并保留`previous_job_id`；活动/成功任务不续作。当前来源、规则、模型或引擎与原任务不一致时拒绝续作，需显式新建整理。相同request-key仍查回原回执。

首次响应和每批补摘要在私有preparation目录原子保存`checkpoint.json`。显式续作只复用同引擎/来源/规则/模型且具体输入、提示词、schema一致的完整检查点；不复用未完成调用、旧引擎的output/result.json或未知结果。每次复用复制到本次私有目录，允许多次显式续作；文件残缺/身份不符时不采纳。不自动重试、不启动worker、不延长原任务deadline。历史无检查点或规则变化的失败任务可明确新建整理，不能宣称能无损续算旧模型调用。

CLI的start/resume/diagnose使用同一HTTP契约；diagnose只返回状态、停止原因及结果计数，不输出正文、摘要、备注或模型私有事件。CLI语法唯一来源见[CLI说明](../../cli/README.md#可选材料整理)。隔离测试证明检查点身份和调用次数，不能证明正在运行的服务已加载新代码。

### 心跳瞬时故障边界

库任务每15秒更新心跳。数据库写入异常时仅在最后确认的租约有效期内继续等待下一轮心跳；成功后按请求发起时刻加120秒保守更新本地租约期限。独立租约计时器覆盖数据库查询悬挂；到期停止并记录`heartbeat_unavailable`。明确取消、失租和任务总期限继续立即生效；发布事务仍检查数据库租约。该机制不重新派发任务、不延长任务总预算。

R12单次整理：页面重新整理通过force显式跳过成功结果复用（在途仍复用），列表先按来源/项目过滤；建题只匹配当前引擎结果，项目专属优先。新任务不让Agent判断unit_kind，来源类别不全时不宣称真实完整文书数量。总摘要由Agent仅根据可见事实生成并传给作者，不再拼接替换。旧题快照保持原样。

材料整理v9输入直接由readPreparationSource查库并内联到单次Agent请求，不生成source.json或要求Agent读取材料输入文件；检查点、请求诊断和输出仍由既有私有执行目录保存。引擎身份变更，不复用v8调用检查点。

材料整理v10与出题/作答共用documentPagesToModelText，输入仅带材料ID、标题和保留页码/表格合并关系的正文，不传结构坐标对象；程序持有完整原结构以绑定返回元数据。评分使用作答冻结正文，不重新转换。历史任务与快照保留原版输入。

2026-10-29用户修订：8分钟为耗时观察点，不作为主动停止或禁止继续的门槛；新prepare默认执行预算30分钟。已领取任务继续使用原冻结预算，无法原地扩展，终态后仅经显式prepare-resume并指定新预算继续，不自动重发未知调用。


材料整理进度复用library_jobs.progress：prepare_input准备输入、agent_analyzing等待Agent完整返回、parse_result核对JSON、publish_result入库。phase_started_at记录阶段开始，附带材料条数等计数，不记录正文或伪造分析百分比。终态以job.status为准；进度写入失败只记录安全告警，不使有效结果失败或重调Agent。旧在途任务不会补造阶段。


## 原子提取入库（054，源码已接入；应用迁移并加载新版API/worker后生效）

新上传不再先创建包或文件集合。`POST /api/material-library/imports`接收multipart的`name`、UUID `request_key`和1–100份`files`，返回独立提取任务ID及202；原件只放私有任务暂存目录，正式`library_packages/revisions/files/blobs/documents`尚无新增数据。共用设置及供应商冻结后复用原API/internal槽位，不另建worker、不超额执行。

整包全部文件完成提取并有可用正文后，原发布事务内创建包（或锁定既有包并检查If-Match）、版本、原件与提取正文，绑定任务到版本并标记成功；任一校验或数据库写入失败则整个事务回滚。新版本不会先替换已有成功版本。更新入口`POST /packages/:id/revisions`也返回独立任务，正式版本仅成功后产生。旧空包创建`POST /packages`返回410，客户端应改用imports；上传成功不是入库成功。

`GET /imports`只列最近50条独立任务摘要，失败只在这里/任务详情显示错误；成功后返回正式package_id/revision_id。相同键与内容恢复原任务，包括失败终态，不自动重提取；失败后重新选择文件提交新任务。临时文件在成功或已确认的失败后清理；进程中断/提交回执未知时先对账，不为清理删除可能已成功登记的原件。

迁移054允许独立任务在尚未发布时不绑定正式包/版本，仅允许发布事务一次性绑定冻结身份；延迟约束阻止新包、版本和原件在没有完整成功提取时提交。迁移不清理或回写历史失败数据，也不取消在途作业。原API、worker和旧客户端需协调更新，不能只部署前端或只重启单个旧消费者；未迁移时新imports明确503，禁止回退到先建记录。
