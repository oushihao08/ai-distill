<!-- 文件职责：说明全局材料库的存储、处理配置、API、任务、项目加载与文件阅读。 -->
# 独立材料库

本模块管理不属于任何项目的材料包和不可变文件集合。同一包可加载到多个项目；只有成功且校验可用的脱敏结果可以被加载、创建题目私有快照。入库/提取/脱敏不创建旧材料包工作流，也不向legacy材料表写库级原件。

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
| `projects.ts`、`questions.ts` | 项目加载与选版/移除；从明确脱敏结果建立完整题目私有快照 |
| `routes.ts` | `/api/material-library` 的资料、版本、任务、配置、预览和使用关系接口 |

原件位于`<STORAGE_DIR>/material-library/blobs/`；共用处理设置位于同目录下私有`processing-settings.sqlite3`；DOCX预览缓存位于`previews/`，转换临时目录和用户profile使用后删除。所有SQLite配置供同一STORAGE_DIR的本机API实例共用；未承诺多台独立API自动同步本地配置。worker读取已冻结的PostgreSQL任务快照，不在执行中重新读取本地共用配置。

包名称/说明/标签与处理设置分开。历史`library_packages.processing_settings`保留兼容初始快照，不再作为新任务执行配置，也不从包详情返回；包创建/更新接口拒绝单包处理配置写入。未保存共用配置时，从数据库系统提示词与当前系统模型/提取默认组合完整配置。保存后的共用设置只影响之后派发的新任务，历史任务与题目快照不回写。

## 页面与接口

材料库从本机文件夹导入PDF/DOCX/TXT/MD，手动执行入库、识别和脱敏。页面默认以文件为中心：原文件、识别原文、单文件脱敏文本、对应版本对照；历史任务放在“处理记录”，按题目汇总使用状态，展开才显示归档/撤回时间线。更新文件创建新集合，不修改旧文件。

- `GET/PUT /processing-settings`：读取/保存全库共用处理配置；PUT必传If-Match版本，首次保存版本为0，冲突409。
- `GET /processing-defaults`：当前系统默认，仅显式应用到共用设置草稿。
- `GET /files/:id/content`：下载原件；`GET /files/:id/preview`：原文件内嵌预览。先核对file→revision→package、执行端、路径、摘要和大小。DOCX预览依赖已安装的LibreOffice（可通过LIBREOFFICE_PATH指定）；不上传第三方，不调用模型。生成副本的分页可能受可用字体和渲染器影响，原件始终保留。
- `GET /revisions/:id/documents?extraction_job_id=...`：成功同集合提取任务的文件摘要/识别问题；加file_id按需读取单文件正文。
- `GET /redactions/:id/preview`：成功脱敏全文；加file_id返回该文件页文本，并返回实际extraction_job_id，前端对照读取这个提取来源。
- `GET /packages?ready_only=true`：在分页前按全部历史可用脱敏结果过滤。新文件版本失败不隐藏旧成功版；POST加载/PATCH选版在包/项目事务锁内再次验证非空且有效的选择。
- `GET /packages/:id/usage`：加载项目与归档/撤回事件。界面按题目汇总当前状态，事件历史保留；移除引用和删除项目不改变全局库包。

正文预览上限4MiB，超过时明确拒绝而不是截断。原件PDF按原字节返回；DOCX缓存最大32MiB，缺转换器、超时或转换失败显示可操作错误。macOS的部分headless发行版遗漏当前系统字体资源路径，会出现可复制但不可见的中文；转换只在私有临时fontconfig中补入系统字体目录，不安装或修改全局字体。

任务详情只投影状态、计数、安全错误、previous_job_id、extraction_job_id、cancel_requested_at；不返回input/config快照。取消排队任务同步终止，运行任务等待执行器结束；失租不退回排队。重试新建任务并保留来源，使用新的共用配置。旧缺少冻结PDF供应商的任务不能默默改用新环境，需新尝试。

## 验证与维护边界

脱敏派发、执行及建题来源复制前共用 `assertLibraryExtractionUsable()` 检查文件、页数和正文可处理性；整个文件无正文时在模型调用前明确拒绝，空白页随有正文的其余页保留。OCR issues 是识别提示，不能等同于脱敏丢失内容，不再仅凭提示数量阻断脱敏或建题。提示保留在提取文档、脱敏索引及 validation_report.extraction_issues 中，原件摘要、页/字段覆盖及原文定位仍校验。脱敏验收比较已提取原文与脱敏正文的实质内容，允许正常遮盖及无实质影响的格式差异；usable_for_question 表示输入和脱敏产物可用于建题，不证明原PDF逐字OCR准确。此政策不回写历史任务/产物。

`storage.test.ts`验证原件边界；`service.test.ts`验证资料、清单、恢复和使用历史；`jobs.test.ts`验证lane、取消/失租/晚到结果；`projects.test.ts`、`questions.test.ts`验证加载/快照；`preview.test.ts`验证身份限制与正文摘要。单元检查不等于真实OCR/脱敏质量。

042/043已在用户确认的隔离库登记。合成入库/提取、跨项目加载、模拟下游、DOCX/XLSX及归档撤回的既有证据见执行追踪；2026-10-18的新界面、DOCX中文/表格显示、共用设置回读等证据见`docs/evidence/2026-10-18-material-library-reader.md`。真实模型质量和远端双机未在本轮验收。

文件系统与PostgreSQL不是同一原子事务；提交未知时保留对象并按幂等key核对，不因单请求失败清理可能已被引用的blob。旧流程保留，不迁移或清理旧业务数据。

材料包列表支持 `q`、重复的 `project_id`、`redaction_state=all|ready|not_ready` 组合筛选，筛选在分页之前执行。项目多选取当前有效加载关系的并集，忽略移除关系及已删除项目；脱敏状态按是否存在成功且可用于建题的版本判断，兼容原 `ready_only` 参数。`GET /api/material-library/project-options` 提供未删除项目的轻量选项。
