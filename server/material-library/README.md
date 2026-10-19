<!-- 文件职责：说明全局材料库的存储、处理配置、API、任务、项目加载与文件阅读。 -->
# 独立材料库

本模块管理不属于任何项目的材料包和不可变文件集合。同一包可加载到多个项目（包括既有 legacy 项目）。期次出题设置默认选择成功脱敏版本，也可选择已完成 MinerU 提取的原文版本；题目级 `question_library_sources` 冻结来源模式、版本与正文/索引，后续出题、作答、评分和交付均按该快照读取。原文模式只发送已提取文本与结构，不发送原始二进制。未绑定共享库快照的旧题继续走原步骤 1/9，旧目录建题流程仍只支持脱敏；共享材料快照题可用于新旧项目，项目 `material_backend` 不因此改变。入库/提取/脱敏不创建旧材料包工作流，也不向 legacy 材料表写库级原件。

## 模块与存储

| 文件 | 职责 |
| --- | --- |
| `storage.ts` | 原件内容寻址安装、受管路径/符号链接边界和字节摘要校验 |
| `service.ts` | 包资料、不可变文件集合、上传幂等、逻辑归档/恢复、历史与使用查询；保留初始配置构建及校验函数 |
| `settings.ts` | 当前本地工作台所有包共用的处理设置，沿用本机SQLite配置模式；乐观版本控制、事务保存，不保存密钥 |
| `jobs.ts` | 入队时读取共用设置并冻结；请求重放、执行lane、租约、取消、失租和终态事务 |
| `runner.ts` | 复用现有文本提取和字段映射脱敏，发布库级结果；新提取任务冻结PDF供应商 |
| `preview.ts` | 按文件/成功提取任务/成功脱敏结果身份按需读取正文，校验摘要；单文件脱敏通过索引定位，拒绝任意blob读取 |
| `original-preview.ts` | PDF/TXT等原件直接查看，DOCX由隔离LibreOffice生成只读PDF副本；串行转换、60秒时限、按源摘要和渲染版本缓存 |
| `projects.ts`、`questions.ts` | 项目加载与选版/移除；按期次所选模式从脱敏结果或 MinerU 提取版本建立完整题目私有快照 |
| `projects-routes.ts`、`uses.ts` | 本期材料候选分页、加载引用/恢复、题目创建入口及本期使用状态/单条事件读取 |
| `routes.ts` | `/api/material-library` 的资料、版本、任务、配置、预览和使用关系接口 |
| `legacy-import.test.ts` | 旧包原件/成功提取导入的页序、摘要、状态与原期使用关系校验；不测试脱敏或修改旧题 |
| `projects-routes.test.ts` | 候选分页与并行读取、已移除引用恢复及单条使用事件路由边界 |
| `uses.test.ts` | 原件集合身份、跨期占用、原期返修、提交证据和事件摘要边界 |

原件位于`<STORAGE_DIR>/material-library/blobs/`；共用处理设置位于同目录下私有`processing-settings.sqlite3`；DOCX预览缓存位于`previews/`，转换临时目录和用户profile使用后删除。所有SQLite配置供同一STORAGE_DIR的本机API实例共用；未承诺多台独立API自动同步本地配置。worker读取已冻结的PostgreSQL任务快照，不在执行中重新读取本地共用配置。

包名称/说明/标签与处理设置分开。历史`library_packages.processing_settings`保留兼容初始快照，不再作为新任务执行配置，也不从包详情返回；包创建/更新接口拒绝单包处理配置写入。未保存共用配置时，从数据库系统提示词与当前系统模型/提取默认组合完整配置。保存后的共用设置只影响之后派发的新任务，历史任务与题目快照不回写。

## 页面与接口

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

- 主项目内的占用按同一 `package_id` 或完整原件集合签名判断。签名对原件 SHA/大小去重排序，不受文件名和顺序影响；它不是任意部分重叠检测。同一期可以围绕已加载材料创建多题，同一主项目其他期不能重新占用；返修回到原所属期，事件账独立于题目保留。
- 使用状态更新必须带原因和乐观版本。登记 `submitted` 时，`evidence` 必须包含非空的 `platform`、`project_id`、`task_id`、可解析的 `submitted_at`、`receipt`；字段完整性校验不等于系统已向外部平台验证真实性。
- 普通上传当前将原件安装为 `storage_target=local`。任务要求所有原件目标与 `execution_target` 一致，服务器执行并不自动搬运原件；题目来源私有复制当前也要求本机可读来源。旧 remote-material 同步接口处理旧工作流，不负责搬运全局材料库 blob。
- 建题请求用 `request_key` 防重，同时校验 `expected_link_version`；来源字段为 `redaction_id` 或 `revision_id` 二选一，并与本期出题模式一致。成功后冻结快照，后改期次设置不切换旧题来源。

旧材料导入默认 `dry_run=true`，apply 必须显式传 `dry_run=false` 和预检的 `expected_source_digest`。只有所有文件均有校验通过的旧提取结果，才登记完整成功的导入提取任务；部分提取不冒充完整成功。激活仅衔接原期材料引用/使用账，可能保留未选版本，仍需选取可用来源才能新建题目。
