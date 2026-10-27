# 材料提取、脱敏与DOCX

本模块提供格式解析、MinerU适配、脱敏正文/索引渲染和材料DOCX。旧工作流使用步骤1、内部2及人工声明的步骤9；当前整包Agent化名由`../material-library/`执行。全局库revision/job与旧材料工作流身份独立。提取成功不等于OCR准确，技术结构有效不等于零脱敏遗漏。

## 文件与入口

| 文件 | 职责和边界 |
| --- | --- |
| `document.ts` | `ProjectDocumentExtractor.extract()`按格式分流并核对源SHA；`extractPages()`以Poppler生成问题页PDF子集后调用同一provider并映回原页码。PDF必须注入provider，DOCX有provider走它，否则保留本地OOXML兼容解析；TXT/MD本地UTF8。当前队列为PDF/DOCX注入MinerU。 |
| `jobs.ts` | 旧步骤2入队、冻结MinerU配置/转换版本、按执行端领取/缓存/发布；更新步骤1处理状态，非全局库队列。 |
| `process.ts` | `processMaterials()`核对原件/缓存，生成私有页结构；只对可重试问题页做一次子集复识别并保留issues，无页级能力则标记不可复查，不整份重传。旧无调用的检查点清理入口已移除，不删除历史缓存。 |
| `pdf.ts` | 当前共享Page/DocumentBlock和确定性`documentBlocksToText()`；`command()`封装Poppler；`extractPdf()`是旧Vision页级路径，非当前MinerU主入口。 |
| `pdf-split.ts` | `splitLargePdf()`供旧目录同步，按页/大小拆至受管缓存，不修改来源；不是所有全局库上传的自动拆片器；有qpdf时按范围导出并清除未引用资源，避免共享资源被逐页重复携带，无qpdf仍用Poppler兼容路径。 |
| `pdf-extraction/` | MinerU API/CLI与结构转换，详见本目录README。 |
| `config.ts` | `loadExtractionConfig()`读JSON兼容识别配置，仅用EXTRACTION_CONFIG_PATH选文件；不是当前MinerU逐字段环境配置合并器。 |
| `vision.ts` | 旧智谱OCR/实体客户端，保留调查与测试路径；当前MinerU队列不调用。 |
| `state.ts` | 旧附件/脱敏设置变更的事务失效；保留历史，取消活动尝试，使依赖当前结果失效。共享库题目来源保持独立冻结。 |
| `redaction-config.ts` | 合并API/Codex默认和校验；`sameRedactionConfig()`比较有效配置，忽略键序和等价默认。 |
| `redaction-jobs.ts` | 旧步骤9只处理人工已脱敏声明，重验来源并原子发布；旧字段映射冻结任务明确失败，不再复用或调用模型。 |
| `redaction.ts` | 仅保留`renderRedactedMaterials()`渲染同源正文/结构索引及历史协议标识，不包含模型执行。 |
| `redacted-docx.ts` | 兼容导出公共`document-generation/docx.ts`的`buildDocx()`纯文字/结构渲染；默认连续排版并跳过纯空段/空页，只有显式pagination=source才保留扫描页硬分页，表格单元格采用紧凑段距；名称兼容，可接受已核验脱敏或明确冻结原文，不读取原件、数据库或图片。可选 `style: legal` 只供 Work 业务成稿使用宋体正文、黑色标题及行距，并保留逐行文书字段，独立首段使用标题样式；默认附件渲染不变。 |
| `redacted-docx-export.ts` | `readCurrentRedactionForDocx()`核验所选模式结构，`exportCurrentMaterialDocx()`按冻结顺序合并为一份DOCX并生成/复用，`readCurrentMaterialDocx()`安全下载；`readOriginalFilesForDelivery()`仅在归档原文模式按冻结清单和SHA读取原件；`questionResultDirectory()`和`isLibraryDocxPath()`共用目录契约。 |

`*.test.ts`验证范围分别看文件头与用例，未运行不能说通过。材料/缓存/续接测试覆盖旧解析；redaction队列测试覆盖旧任务拒绝及人工声明发布；DOCX测试覆盖结构字节与来源绑定。测试、真实供应商、GUI视觉和完整业务分别报告。

### 测试文件映射

这些测试使用本地替身或合成文件，不连接真实 MinerU/模型服务；运行情况须单独报告。

| 文件 | 核对边界 |
| --- | --- |
| `continuation.test.ts` | OCR响应不完整、单页失败后的后续页处理，以及无实体调用的结构化保存 |
| `document.test.ts` | PDF必须显式提供解析器；TXT/MD结构投影保留原始空白；本地Poppler子集只向假provider提交指定页，验证页序、原件不变、临时清理与取消 |
| `jobs.test.ts` | 提取队列的MinerU配置冻结、有限回退、尝试去重和来源绑定 |
| `materials-cache.test.ts` | 缓存来源与摘要验证、OCR问题复查、脱敏指纹兼容及DOCX结构提取 |
| `materials.test.ts` | 旧页级OCR/实体脱敏路径的页序、跨页替换和结果生成 |
| `pdf-extraction/mineru-structure.test.ts` | MinerU PDF/DOCX不同结构版本的顺序、表格、图像文字和问题标记 |
| `redacted-docx.test.ts` | 由传入正文/结构生成DOCX、保留附件分页与表格，并拒绝空来源 |
| `redacted-docx-export.test.ts` | DOCX导出的步骤资格、来源/摘要、路径隔离、回滚和产物索引绑定 |
| `redaction-jobs.test.ts` | 旧脱敏队列锁、声明已脱敏附件、冻结输入、取消及原子发布 |
| `remote-routing.test.ts` | 本机与服务器材料worker按execution_target隔离领取 |
| `speed-quality.test.ts` | 旧PDF OCR并发上限、页序和有限重试后续页继续 |

## 来源、缓存与执行端

旧目录按题目入库，旧材料包先处理material_package，再由`../material-package-questions.ts`建派生题。全局库由`../material-library/questions.ts`冻结脱敏或成功提取原文，默认脱敏；创建后期次设置变化不切换旧题来源，出题/作答/评分/归档均使用同一快照。派生题不再运行旧入库/脱敏。主项目永久使用账不归本模块管理。

旧提取入队冻结PDF provider及转换版本，API默认优先，符合特定网络/服务/超时错误时才回退一次CLI；DOCX直接MinerU API，忽略图片、按原文序映射为单逻辑页。TXT/MD本地解析。两种MinerU方式需MINERU_KEY，当前队列不回退智谱。健康与问题提示保留，不能将issues直接等同于脱敏遗漏。

提取入队可复用同来源/配置的成功尝试，活动去重；执行时另选同来源/供应商配置的历史PDF产物，校验文件、SHA、结构文字投影，不等于只读取成功尝试缓存。损坏缓存可重新提取。只对OCR空白页或empty_page/truncated_response/ocr_page_error/unreadable问题做一次复查；image_without_text、未知块/表格结构提示不触发再次收费。复查通过pdfseparate/pdfunite在私有临时目录构造问题页子集，交给原provider，验证子集摘要、原件绑定及返回页数/页序后只替换指定页，正常缓存页保留复用及usage身份。缺少extractPages能力的注入提取器保留原文并添加ocr_recheck_unavailable，不降级为整份重传；结果仍有问题时保留issues，不阻断旧入库。全局库有自己的可用性判断，不套用旧队列状态。

`redaction.ts`只保留正文/索引渲染及历史协议标识；不执行字段映射或模型脱敏。`processMaterials()`的旧签名参数仅兼容现有工具，不作为Vision实体识别或旧配置的执行开关。

旧任务按execution_target领取，入库派生提取继承目标；管理文件在执行机.storage，远程旧材料同步通过HTTP清单/摘要，不负责全局库blob搬运。worker主动停止可退回旧提取等待，五分钟失联记失败；全局库租约过期则失败，不能用同一恢复描述。

旧目录PDF超过200页或MAX_FILE时可拆片，先按页再按大小细分，最多100片，单页仍超限失败；源目录不改，不压缩图片。缓存键绑定源字节/名称/限制，已有片复用只检查列表/大小，不重新逐片算SHA/页数。下游仍校验实际入库文件。大小上限由validation和具体上传路径决定，不拿目录拆片上限套所有接口。

## Agent化名与旧结果边界

新材料库仅执行`aliases/codex_plan`整包化名，入口与加固规则见[材料库说明](../material-library/README.md)。旧`mask/field_mapping`模型引擎、API批池、字段重试及检查点执行已经删除；旧队列不能新派或重放旧模型任务，已冻结待执行任务以`field_mapping_removed`失败，不读取正文或调用模型。

历史协议字符串、输入摘要、结果正文与结构仍用于只读展示、DOCX导出和来源冻结校验；不删除业务记录、产物或历史检查点，不将旧结果改标为化名。旧人工声明流程独立保留，不代表程序已验证零敏感信息。

## DOCX与人工脱敏声明

DOCX可声明declared_redacted，仍完整提取，声明内容原样进入正文/结构，旧流程仅全声明附件可直通，含未声明附件拒绝并提示使用共享库；共享库Agent化名仍审阅整包。声明需绑定当前附件身份，变更影响旧流程当前下游，替换附件恢复默认；全局库声明随不可变文件集合冻结。

材料DOCX接口不注册新步骤或attempt。有有效脱敏结果或冻结原文来源即可独立生成，不以出题、评分、达标、归档完成或这些步骤空闲为前置。`readCurrentRedactionForDocx()`复用同一来源读取器；版本、结构、文件归属及摘要校验仍保留。`allowPublicationInProgress`仅保留调用签名兼容，不是当前导出资格开关。

当前材料导出一题一份“脱敏材料.docx”或“原文材料.docx”，按冻结的分册/原件顺序组合正文与结构；不重新OCR。脱敏模式禁止混入原文结构。旧无结构索引使用Markdown兼容渲染，不能声称保留不存在的结构。渲染支持标题、段落、列表、表格合并、脚注段落样式及分页；不创建真实Word脚注关系、不含图片、不承诺逐像素版式。

生成/复用检查来源模式、正文/结构、manifest、渲染版本和DOCX摘要。下载检查当前来源索引、模式、material_id、attempt、受管路径与文件SHA；`readCurrentRedactedDocx`只是兼容别名，不强制切换来源模式。当前产物索引与磁盘历史文件分开；历史文件不作为当前下载入口。

产物位于assets/out/附件库/<主项目>/<期次>/<题目>/，兼容无期次旧路径；原件/DOCX均私有，原件副本不代表允许把它发送给脱敏作答者。材料导出只更新artifact，不改业务步骤；失败尝试恢复文件，但文件与数据库非原子，提交未知必须核对。工作流重置另按共同路径契约清理，不混同逻辑移除或材料库归档。

操作授权和敏感信息边界遵循根AGENTS.md；本说明为源码核对结果，不证明当前worker已加载、真实OCR/脱敏质量或完整业务验收。

DOCX渲染版本为redacted-structure-docx-v3，版本参与缓存索引；连续排版不执行脱敏清理；公共渲染器只在显示副本隐藏独立“（此页无正文）”分页提示，对异常OCR表格网格保留非空文字顺序做单列显示降级，正常表格保留合并关系。来源记录不变。旧题的垃圾扫描标记如需处理，先显式生成清理副本或新脱敏版本；不能在导出时静默改写原文来源或历史冻结数据。

## 显式材料上传预处理

`prepare-library-files.ts`的`prepareLibraryFiles()`由CLI `library files prepare`调用：只读本机清单，OFD通过显式安装的本地OFDRW转PDF，PDF复用`splitLargePdf()`按大小/页数拆片，核对页数后生成新目录中的`manifest.json`及`provenance.json`。不自动上传、不修改来源、不派任务；原材料库HTTP接口的格式集合不变。失败保留`failed.json`但不发布manifest。OFD转换件须页面抽查，数字签名验证不能从原件继承。安装入口见`scripts/runtime/ofd/README.md`。

本模块local队列模式的派发归属、指定ID领取、取消及恢复接入共享[执行队列](../execution-queue/README.md)；业务输入/结果契约保留，默认兼容模式不代表业务环境已切换。

冻结的`prepared_documents`用于逻辑分册导出：仅当正文和可用结构投影一致且正文纯空白时省略该分册，不修改来源快照；重复ID、缺失字段和非空结构矛盾仍拒绝。工作簿按同一分册文件名清单核对齐备性，非分册模式继续核对原材料覆盖。

脱敏DOCX的权威输入是通过摘要验证的冻结脱敏正文和结构。本机不存在原始PDF时，仅省略可选的原件备份；不回退原文、不补造原件。原文模式以及存在但指纹错误、路径越界的原件仍拒绝。





飞书交付调用材料导出时提供`expectedAuthoringInput`，生成前校验有效出题的来源绑定、原件集合的大小和SHA（共享题按冻结源artifact元数据比较）；普通DOCX导出仍独立于题目是否出题。核对回执与失败展示见[飞书交付](../publishing/README.md#飞书交付一致性核对)。

飞书交付的原件核对先读取完整冻结清单；新快照检查source_document产物ID、摘要及大小。字段不存在或为null的旧快照按冻结material ID/SHA核对并强制实读原件大小/摘要，不修改历史快照；存在非空产物ID但关联丢失或损坏不走兼容路径。

生命周期回调由[同步增强层](../lifecycle/README.md)统一注册，事件接入现有执行/保存边界；无注册时保持原流程。

项目差异统一从[lifecycle](../lifecycle/README.md)注册；提取provider、来源模式和脱敏执行仍属通用配置。步骤事件支持按主项目key订阅，只有实际存在key订阅时才查身份，不更改历史材料/任务快照。

本机明确新派发可在同一事务替代他机尚未开始的同范围待办；运行、结果未知和续作仍受保护，新派发失败则旧意图变更回滚。适用范围、共享状态兼容与验证边界见[执行队列的跨机准入](../execution-queue/README.md#他机未开始待办与本机明确派发)。
