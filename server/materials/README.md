# 材料提取、脱敏与DOCX

本模块提供格式解析、MinerU适配、结构化字段脱敏和材料DOCX。旧工作流的入库/提取/脱敏由步骤1、内部2、9执行；全局材料库由`../material-library/`的独立revision/job调用这里的解析和脱敏能力。不要把全局库任务与旧material_package工作流混为一谈。提取成功不等于OCR准确，脱敏结构有效不等于零漏识别。

## 文件与入口

| 文件 | 职责和边界 |
| --- | --- |
| `document.ts` | `ProjectDocumentExtractor.extract()`按格式分流并核对源SHA；PDF必须注入provider，DOCX有provider走它，否则保留本地OOXML兼容解析；TXT/MD本地UTF8。当前队列为PDF/DOCX注入MinerU。 |
| `jobs.ts` | 旧步骤2入队、冻结MinerU配置/转换版本、按执行端领取/缓存/发布；更新步骤1处理状态，非全局库队列。 |
| `process.ts` | `processMaterials()`核对原件/缓存，生成逐材料私有页结构；问题OCR页重新提取一次，仅替换问题页，保留issues。`clearExtractionCheckpoints()`是旧Vision检查点兼容。 |
| `pdf.ts` | 当前共享Page/DocumentBlock和确定性`documentBlocksToText()`；`command()`封装Poppler；`extractPdf()`是旧Vision页级路径，非当前MinerU主入口。 |
| `pdf-split.ts` | `splitLargePdf()`供旧目录同步，按页/大小拆至受管缓存，不修改来源；不是所有全局库上传的自动拆片器；有qpdf时按范围导出并清除未引用资源，避免共享资源被逐页重复携带，无qpdf仍用Poppler兼容路径。 |
| `pdf-extraction/` | MinerU API/CLI与结构转换，详见本目录README。 |
| `config.ts` | `loadExtractionConfig()`读JSON兼容识别配置，仅用EXTRACTION_CONFIG_PATH选文件；不是当前MinerU逐字段环境配置合并器。 |
| `vision.ts` | 旧智谱OCR/实体客户端，保留调查与测试路径；当前MinerU队列不调用。 |
| `redact.ts` | 旧实体/规则替换辅助，当前字段映射主流程不由它定义。 |
| `state.ts` | 旧附件/脱敏设置变更的事务失效；保留历史，取消活动尝试，使依赖当前结果失效。共享库题目来源保持独立冻结。 |
| `redaction-config.ts` | 合并API/Codex默认和校验；`sameRedactionConfig()`比较有效配置，忽略键序和等价默认。 |
| `redaction-execution.ts` | 有界批次、时限和token估算；缺省不等于每个调用方的冻结值。 |
| `redaction-jobs.ts` | 旧步骤9冻结原文/配置/协议/预算，执行后重验来源与配置，保存完整脱敏正文/结构；全局库使用独立runner。 |
| `redaction.ts` | `redactExtractedMaterials()`逐字段映射，`applyStructuredRedactions()`定位/清理/遮罩，`renderRedactedMaterials()`同源正文和索引，`filterRedactionFormatting()`固定格式清理。 |
| `redacted-docx.ts` | 兼容导出公共`document-generation/docx.ts`的`buildDocx()`纯文字/结构渲染；默认连续排版并跳过纯空段/空页，只有显式pagination=source才保留扫描页硬分页，表格单元格采用紧凑段距；名称兼容，可接受已核验脱敏或明确冻结原文，不读取原件、数据库或图片。可选 `style: legal` 只供 Work 业务成稿使用宋体正文、黑色标题及行距，并保留逐行文书字段，独立首段使用标题样式；默认附件渲染不变。 |
| `redacted-docx-export.ts` | `readCurrentRedactionForDocx()`核验所选模式结构，`exportCurrentMaterialDocx()`逐附件生成/复用，`readCurrentMaterialDocx()`安全下载；`readOriginalFilesForDelivery()`仅在归档原文模式按冻结清单和SHA读取原件；`questionResultDirectory()`和`isLibraryDocxPath()`共用目录契约。 |

`*.test.ts`验证范围分别看文件头与用例，未运行不能说通过。材料/缓存/续接测试覆盖旧解析；redaction结构/性能/执行测试覆盖字段与预算；DOCX测试覆盖结构字节与来源绑定。测试、真实供应商、GUI视觉和完整业务分别报告。

### 测试文件映射

这些测试使用本地替身或合成文件，不连接真实 MinerU/模型服务；运行情况须单独报告。

| 文件 | 核对边界 |
| --- | --- |
| `continuation.test.ts` | OCR响应不完整、单页失败后的后续页处理，以及无实体调用的结构化保存 |
| `document.test.ts` | PDF必须显式提供解析器；TXT/MD结构投影保留原始空白 |
| `jobs.test.ts` | 提取队列的MinerU配置冻结、有限回退、尝试去重和来源绑定 |
| `materials-cache.test.ts` | 缓存来源与摘要验证、OCR问题复查、脱敏指纹兼容及DOCX结构提取 |
| `materials.test.ts` | 旧页级OCR/实体脱敏路径的页序、跨页替换和结果生成 |
| `pdf-extraction/mineru-structure.test.ts` | MinerU PDF/DOCX不同结构版本的顺序、表格、图像文字和问题标记 |
| `redacted-docx.test.ts` | 由传入正文/结构生成DOCX、保留附件分页与表格，并拒绝空来源 |
| `redacted-docx-export.test.ts` | DOCX导出的步骤资格、来源/摘要、路径隔离、回滚和产物索引绑定 |
| `redaction-execution.test.ts` | 脱敏默认与显式模型设置、思考开关和预算边界 |
| `redaction-jobs.test.ts` | 旧脱敏队列锁、声明已脱敏附件、冻结输入、取消及原子发布 |
| `redaction-performance.test.ts` | API批次预算/并发/超时/补做/断点恢复及晚到结果处理 |
| `redaction-structure.test.ts` | 映射定位、确定性遮罩、结构还原、缺失字段和断点校验 |
| `remote-routing.test.ts` | 本机与服务器材料worker按execution_target隔离领取 |
| `speed-quality.test.ts` | 旧PDF OCR并发上限、页序和有限重试后续页继续 |

## 来源、缓存与执行端

旧目录按题目入库，旧材料包先处理material_package，再由`../material-package-questions.ts`建派生题。全局库由`../material-library/questions.ts`冻结脱敏或成功提取原文，默认脱敏；创建后期次设置变化不切换旧题来源，出题/作答/评分/归档均使用同一快照。派生题不再运行旧入库/脱敏。主项目永久使用账不归本模块管理。

旧提取入队冻结PDF provider及转换版本，API默认优先，符合特定网络/服务/超时错误时才回退一次CLI；DOCX直接MinerU API，忽略图片、按原文序映射为单逻辑页。TXT/MD本地解析。两种MinerU方式需MINERU_KEY，当前队列不回退智谱。健康与问题提示保留，不能将issues直接等同于脱敏遗漏。

提取入队可复用同来源/配置的成功尝试，活动去重；执行时另选同来源/供应商配置的历史PDF产物，校验文件、SHA、结构文字投影，不等于只读取成功尝试缓存。损坏缓存可重新提取。OCR问题页会调用provider再提一次，仍留问题不阻断旧入库；全局库有自己的可用性判断，不套用旧队列状态。

旧任务按execution_target领取，入库派生提取继承目标；管理文件在执行机.storage，远程旧材料同步通过HTTP清单/摘要，不负责全局库blob搬运。worker主动停止可退回旧提取等待，五分钟失联记失败；全局库租约过期则失败，不能用同一恢复描述。

旧目录PDF超过200页或MAX_FILE时可拆片，先按页再按大小细分，最多100片，单页仍超限失败；源目录不改，不压缩图片。缓存键绑定源字节/名称/限制，已有片复用只检查列表/大小，不重新逐片算SHA/页数。下游仍校验实际入库文件。大小上限由validation和具体上传路径决定，不拿目录拆片上限套所有接口。

## 当前字段脱敏协议

权威常量为`attachment-field-redaction-v32`。程序恢复附件、页序和结构；模型仅返回字段映射。API用严格schema字典`fields:{f1:[{source_text,kind,mask_text}],...}`，本批编号全为必填；Agent用target_id数组。兼容数组/单字段修复不允许把缺失当空数组，完整覆盖与源定位仍检查。

固定清理先还原Markdown标点转义，删除方括号内容及特定数字前缀扫描水印，还原百分号包装；普通正文日期不因此删除。按项目提示词检测金额/日期保留政策。模型cleanup只能定位实际垃圾，不重写正文；含真实日期的长段清理拒绝，不能确认且触及保护金额/日期时保留。format映射忽略，格式处理由程序完成。

定位先精确匹配，再容忍空白/Unicode兼容形式、中文分隔符及汉字间OCR符号、星号转义；数字横线/小数点仍区分。真实敏感片段找不到则失败。重复及重叠遮罩合并，姓名/电话/编号/案号由确定性规则处理；其他类别可按合法子串遮罩，不能用模型任意mask覆盖政策。组织保留明确后缀，仅对本题已识别的商户/负责人做有限归一，不跨题共享主体。

全部字段通过才发布同源Markdown和redacted-index-v2：内部附件/页标记由程序添加，结构投影/摘要留存，原文issues不丢。成功状态不证明模型没有漏识别敏感信息或误判垃圾；人工声明不等于零敏感验证。

## API与Agent预算、断点

缺省为256字段/10000字符/12000估算输入token/32768输出token，批并发8、排队45秒/请求60秒/整题20分钟/停滞6分钟。允许合法覆盖，旧步骤9的新SiliconFlow任务冻结批并发1；全局库runner使用自己的冻结设置，不能假定也自动采用该覆盖。单并发大任务在旧队列按字段量可扩大整题预算，最多缺省20分钟的三倍。原文加载和保存也计入旧队列整题预算；墙钟/单调时钟共同防止休眠后接收过期结果。

API按同附件跨页字段打包，行上下文和schema计入输入估算；不截断完整字段。输出估算不要求模型重复全文。单字段输入超预算明确失败。请求SiliconFlow时关闭思考；所有默认HTTP调用仍受llm-api本机共享槽位，不等于供应商配额保障。

每批初次+一次修复，仅补失败字段；截断/部分超时可有界拆批，共享原批六次与整题预算，默认整题次数为批数*2+4。少量定位错误有有限隔离机会，剩余失败不发布。局部预算失败继续其他批次并保存有效字段；认证/额度/配置/限流/供应商级错误、全局预算/取消等停止全池。具体分类以代码为准，不将retryable元数据当自动无限重试。

API断点绑定材料、结构字段、模型/提示词及协议，不绑定调度预算；权限受限、单写链和SQLite租约独占。重派同输入只读有效字段，坏断点明确失败，不填空。成功发布后旧队列删除断点正文文件；失败保留已验证字段及私有定位诊断。Agent是一次结构化调用，没有API同样的批池/断点补做路径。不能把所有脱敏方式统一描述为可字段续跑。

进度的completed_fields是已校验保存字段，activity用于停滞边界；heartbeat或call.started不证明供应商仍生成。普通日志只存安全标识、计数、原因，私有诊断可能含未脱敏文本，不公开。新协议不自动重派/重写历史结果。

## DOCX与人工脱敏声明

DOCX可声明declared_redacted，仍完整提取，声明内容原样进入正文/结构，混合包仅未声明部分调用模型；全声明走内部处理。声明需绑定当前附件身份，变更影响旧流程当前下游，替换附件恢复默认；全局库声明随不可变文件集合冻结。

材料DOCX接口不注册新步骤或attempt。导出前要求适用流程完成、步骤8归档且无活动任务；共享库题仅检查4—8，旧题按注册表适用步骤。`readCurrentRedactionForDocx()`供归档预先取结构，不要求先完成8，不是绕过导出资格。

每原附件生成一个DOCX并保留私有原件副本；正文来自题目所选模式索引，不重新OCR。原文模式按显式快照读取MinerU结构，脱敏模式禁止混入原文结构。旧无结构索引用Markdown兼容渲染，不能声称保留不存在的结构。渲染支持标题（最多三级）、段落、项目列表、表格合并、脚注段落样式及分页；不创建真实Word脚注关系、不含图片、不承诺逐像素版式。

生成/复用检查来源模式、正文/结构、manifest、渲染版本和DOCX摘要。下载检查当前来源索引、模式、material_id、attempt、受管路径与文件SHA，不重新核对全部生成manifest字段；旧readCurrentRedactedDocx别名并非强制脱敏。重试逐文件复用，旧合并索引不进入新Excel；磁盘历史文件与当前索引区分。

产物位于assets/out/附件库/<主项目>/<期次>/<题目>/，兼容无期次旧路径；原件/DOCX均私有，原件副本不代表允许把它发送给脱敏作答者。材料导出只更新artifact，不改业务步骤；失败尝试恢复文件，但文件与数据库非原子，提交未知必须核对。工作流重置另按共同路径契约清理，不混同逻辑移除或材料库归档。

操作授权和敏感信息边界遵循根AGENTS.md；本说明为源码核对结果，不证明当前worker已加载、真实OCR/脱敏质量或完整业务验收。

DOCX渲染版本为redacted-structure-docx-v3，版本参与缓存索引；连续排版不执行脱敏清理；公共渲染器只在显示副本隐藏独立“（此页无正文）”分页提示，对异常OCR表格网格保留非空文字顺序做单列显示降级，正常表格保留合并关系。来源记录不变。旧题的垃圾扫描标记如需处理，先显式生成清理副本或新脱敏版本；不能在导出时静默改写原文来源或历史冻结数据。

## 显式材料上传预处理

`prepare-library-files.ts`的`prepareLibraryFiles()`由CLI `library files prepare`调用：只读本机清单，OFD通过显式安装的本地OFDRW转PDF，PDF复用`splitLargePdf()`按大小/页数拆片，核对页数后生成新目录中的`manifest.json`及`provenance.json`。不自动上传、不修改来源、不派任务；原材料库HTTP接口的格式集合不变。失败保留`failed.json`但不发布manifest。OFD转换件须页面抽查，数字签名验证不能从原件继承。安装入口见`scripts/runtime/ofd/README.md`。
