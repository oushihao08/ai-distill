# 材料提取、脱敏与DOCX

## 适用范围与绑定规则

- **当前执行绑定**：以项目、题目、任务、材料包、`revision` 和附件 ID 为准。已派发任务不因正文/配置/提示词/整理结果的内容摘要或环境指纹变化而被拒绝；保留任务取消、最新任务归属、材料集合完整性、结构格式和路径边界检查。摘要字段用于历史记录、内容寻址及缓存。
- **职责范围**：本模块提供格式解析、MinerU 适配、脱敏正文/索引渲染和材料 DOCX。旧工作流使用步骤 1、内部 2 及人工声明的步骤 9；当前整包 Agent 化名由 `../material-library/` 执行。全局库 `revision`/`job` 与旧材料工作流身份独立。提取成功不等于 OCR 准确，技术结构有效不等于零脱敏遗漏。

全局库新材料的原子入库、失败重传及可选脱敏与整理路径见[材料库处理顺序](../material-library/README.md#新材料处理顺序与可跳过步骤)；本目录只说明解析器与旧材料工作流的职责。

材料英文整段过滤共用`shared/material-paragraph-filter.ts`：清理至少两个英文单词、以英文句末标点结束的纯英文说明段，也清理至少八词且含小写字母的纯英文OCR截断段；保留全大写标题、网址、邮箱、编号、单位及中英混排。材料DOCX另外复用独立数字行识别，只移除独立正文段落中的数字行，保留表格数字；独占一行的`[code]`、`[/code]`、`[json]`、`[xml]`及代码围栏仅在导出副本中清空，围栏内正文、行内标记与代码内容保留。材料DOCX渲染时由`document-generation/material-math-docx.ts`把`$ \textcircled{1} $`等确认的圈号转换为Unicode圈号，把支持的`\mathrm{}`、`\prime`、指数表达式转换为Word原生可编辑公式；无法可靠解析的公式保留原文供人工核对。旧提取在复识别/缓存读取后、产物写入前同时更新结构与文字投影；材料DOCX在来源核验后、渲染前过滤副本，新渲染版本使旧DOCX缓存不再直接复用。不修改上传原件或冻结材料，不自动重提取、不自动替换飞书附件。标准成果等非材料DOCX不应用此过滤。

## 文件与入口

| 文件 | 职责和边界 |
| --- | --- |
| `document.ts` | `ProjectDocumentExtractor.extract()`按格式分流并核对源SHA；`extractPages()`以Poppler生成问题页PDF子集后调用同一provider并映回原页码；`collectExtractedPageIssues()`统一汇总页级识别问题、`empty_page` 与 `unreadable`（供 `process.ts` 和 `material-library/runner.ts` 复用）；`normalizeExtractedPageStructure()`补齐默认段落结构并校验/同步文字投影。PDF必须注入冻结provider，DOCX使用MinerU结构化接口，PNG/JPG/JPEG原图直传MinerU API并输出单页结构；TXT/MD本地UTF8。 |
| `jobs.ts` | 旧步骤2入队、冻结MinerU配置/转换版本、按执行端领取/缓存/发布；更新步骤1处理状态，非全局库队列。 |
| `process.ts` | `processMaterials()`核对原件/缓存，生成私有页结构；只对可重试问题页做一次子集复识别并保留issues，无页级能力则标记不可复查，不整份重传。旧无调用的检查点清理入口已移除，不删除历史缓存。 |
| `pdf.ts` | 当前共享Page/DocumentBlock和确定性`documentBlocksToText()`；`command()`封装Poppler；`extractPdf()`是旧Vision页级路径，非当前MinerU主入口。 |
| `pdf-split.ts` | `splitLargePdf()`供旧目录同步，按页/大小拆至受管缓存，不修改来源；不是所有全局库上传的自动拆片器；有qpdf时按范围导出并清除未引用资源，避免共享资源被逐页重复携带，无qpdf仍用Poppler兼容路径。 |
| `pdf-extraction/` | MinerU API/CLI与结构转换，详见本目录README。 |
| `config.ts` | `loadExtractionConfig()`读JSON兼容识别配置，仅用EXTRACTION_CONFIG_PATH选文件；不是当前MinerU逐字段环境配置合并器。 |
| `vision.ts` | 旧智谱聊天视觉/实体客户端，保留调查与测试路径；独立GLM-OCR版面解析不复用此客户端。 |
| `state.ts` | 旧附件/脱敏设置变更的事务失效；保留历史，取消活动尝试，使依赖当前结果失效。共享库题目来源保持独立冻结。 |
| `redaction-config.ts` | 合并API/已注册Agent驱动（`isRegisteredAgentProvider`）默认和校验；`sameRedactionConfig()`比较有效配置，忽略键序和等价默认。 |
| `redaction-jobs.ts` | 旧步骤9只处理人工已脱敏声明，重验来源并原子发布；旧字段映射冻结任务明确失败，不再复用或调用模型。 |
| `redaction.ts` | 仅保留`renderRedactedMaterials()`渲染同源正文/结构索引及历史协议标识，不包含模型执行。 |
| `redacted-docx.ts` | 兼容导出公共`document-generation/docx.ts`的`buildDocx()`纯文字/结构渲染；默认连续排版并跳过纯空段/空页，只有显式pagination=source才保留扫描页硬分页，表格单元格采用紧凑段距；名称兼容，可接受已核验脱敏或明确冻结原文，不读取原件、数据库或图片。可选 `style: legal` 只供 Work 业务成稿使用宋体正文、黑色标题及行距，并保留逐行文书字段，独立首段使用标题样式；默认附件渲染不变。 |
| `redacted-docx-export.ts` | `readCurrentRedactionForDocx()`核验所选模式结构，`exportCurrentMaterialDocx()`按项目布局逐文书或合并生成/复用DOCX，`readCurrentMaterialDocx()`安全下载；`readOriginalFilesForDelivery()`仅在归档原文模式按冻结清单和SHA读取原件；`questionResultDirectory()`和`isLibraryDocxPath()`共用目录契约。 |

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
| `pdf-extraction/mineru-structure.test.ts` | MinerU PDF/DOCX不同结构版本的顺序、表格及图像/未知块文字保留 |
| `redacted-docx.test.ts` | 由传入正文/结构生成DOCX、保留附件分页与表格，并拒绝空来源 |
| `redacted-docx-export.test.ts` | DOCX导出的步骤资格、来源/摘要、路径隔离、回滚和产物索引绑定 |
| `redaction-jobs.test.ts` | 旧脱敏队列锁、声明已脱敏附件、冻结输入、取消及原子发布 |
| `remote-routing.test.ts` | 本机与服务器材料worker按execution_target隔离领取 |
| `speed-quality.test.ts` | 旧PDF OCR并发上限、页序和有限重试后续页继续 |

## 来源、缓存与执行端

旧目录按题目入库，旧材料包先处理material_package，再由`../material-package-questions.ts`建派生题。全局库由`../material-library/questions.ts`冻结脱敏或成功提取原文，默认脱敏；创建后期次设置变化不切换旧题来源，出题/作答/评分/归档均使用同一快照。派生题不再运行旧入库/脱敏。主项目永久使用账不归本模块管理。

旧提取入队冻结PDF provider及转换版本。新提取只允许MinerU API或MinerU CLI；默认MinerU API符合特定网络/服务/超时错误时才回退一次CLI，其他provider配置直接拒绝。DOCX与图片直接使用MinerU API，DOCX按原文序映射为单逻辑页；TXT/MD本地解析。MinerU主用Token为`MINERU_KEY`，可选预备Token与切换方式见[pdf-extraction说明](pdf-extraction/README.md#维护边界)。空白页及provider明确的异常用于局部复查；新解析不生成图片占位或推断式问题标记，历史缓存不回写。

提取入队可复用同来源/配置的成功尝试，活动去重；执行时另选同来源/供应商配置的历史PDF产物，校验文件、SHA、结构文字投影，不等于只读取成功尝试缓存。损坏缓存可重新提取。只对OCR空白页或empty_page/truncated_response/ocr_page_error/unreadable问题做一次复查；新解析不再生成图片无文字、未知块和表格结构降级提示，历史缓存中的旧标记不会触发复查。复查通过pdfseparate/pdfunite在私有临时目录构造问题页子集，交给原provider，验证子集摘要、原件绑定及返回页数/页序后只替换指定页，正常缓存页保留复用及usage身份。缺少extractPages能力的注入提取器保留原文并添加ocr_recheck_unavailable，不降级为整份重传；结果仍有问题时保留issues，不阻断旧入库。全局库有自己的可用性判断，不套用旧队列状态。

`redaction.ts`只保留正文/索引渲染及历史协议标识；不执行字段映射或模型脱敏。`processMaterials()`的旧签名参数仅兼容现有工具，不作为Vision实体识别或旧配置的执行开关。

旧任务按execution_target领取，入库派生提取继承目标；管理文件在执行机.storage，远程旧材料同步通过HTTP清单/摘要，不负责全局库blob搬运。worker主动停止可退回旧提取等待，五分钟失联记失败；全局库租约过期则失败，不能用同一恢复描述。

旧目录PDF超过200页或MAX_FILE时可拆片，先按页再按大小细分，最多100片，单页仍超限失败；源目录不改，不压缩图片。缓存键绑定源字节/名称/限制，已有片复用只检查列表/大小，不重新逐片算SHA/页数。下游仍校验实际入库文件。大小上限由validation和具体上传路径决定，不拿目录拆片上限套所有接口。

## Agent化名与旧结果边界

新材料库仅执行`aliases/codex_plan`整包化名，入口与加固规则见[材料库说明](../material-library/README.md)。旧`mask/field_mapping`模型引擎、API批池、字段重试及检查点执行已经删除；旧队列不能新派或重放旧模型任务，已冻结待执行任务以`field_mapping_removed`失败，不读取正文或调用模型。

历史协议字符串、输入摘要、结果正文与结构仍用于只读展示、DOCX导出和来源冻结校验；不删除业务记录、产物或历史检查点，不将旧结果改标为化名。旧人工声明流程独立保留，不代表程序已验证零敏感信息。

## DOCX与人工脱敏声明

DOCX可声明declared_redacted，仍完整提取，声明内容原样进入正文/结构，旧流程仅全声明附件可直通，含未声明附件拒绝并提示使用共享库；共享库Agent化名仍审阅整包。声明需绑定当前附件身份，变更影响旧流程当前下游，替换附件恢复默认；全局库声明随不可变文件集合冻结。

材料DOCX接口不注册新步骤或attempt。有有效脱敏结果或冻结原文来源即可独立生成，不以出题、评分、达标、归档完成或这些步骤空闲为前置。`readCurrentRedactionForDocx()`复用同一来源读取器；版本、结构、文件归属及摘要校验仍保留。`allowPublicationInProgress`仅保留调用签名兼容，不是当前导出资格开关。

材料导出默认按冻结分册/原件顺序逐份输出，以序号和分册名命名；项目注册合并布局时生成一份“脱敏材料.docx”或“原文材料.docx”。两者均不重新OCR。脱敏模式禁止混入原文结构。`combineMaterialSections()`组合显示副本；首个非空段落/标题与分册标题仅空白不同则复用，避免程序额外加一行相同标题；其他首段及正文中的重复标题保留。同名分册会显示“第N份”，有`duplicate_of`关联的显示“重复件”，原冻结标题和正文不改。旧无结构索引使用Markdown兼容渲染，不能声称保留不存在的结构。渲染支持标题、段落、列表、表格合并、脚注段落样式及分页；不创建真实Word脚注关系、不含图片、不承诺逐像素版式。

生成/复用检查来源模式、正文/结构、manifest、渲染版本和DOCX摘要。下载检查当前来源索引、模式、material_id、attempt、受管路径与文件SHA；`readCurrentRedactedDocx`只是兼容别名，不强制切换来源模式。当前产物索引与磁盘历史文件分开；历史文件不作为当前下载入口。

产物位于assets/out/附件库/<主项目>/<期次>/<题目>/，兼容无期次旧路径；原件/DOCX均私有，原件副本不代表允许把它发送给脱敏作答者。材料导出只更新artifact，不改业务步骤；失败尝试恢复文件，但文件与数据库非原子，提交未知必须核对。工作流重置另按共同路径契约清理，不混同逻辑移除或材料库归档。

操作授权和敏感信息边界遵循根AGENTS.md；本说明为源码核对结果，不证明当前worker已加载、真实OCR/脱敏质量或完整业务验收。

DOCX渲染版本为redacted-structure-docx-v5，版本参与缓存索引；连续排版不执行脱敏清理；公共渲染器只在显示副本隐藏独立“（此页无正文）”分页提示，对异常OCR表格网格保留非空文字顺序做单列显示降级，正常表格保留合并关系。来源记录不变。旧题的垃圾扫描标记如需处理，先显式生成清理副本或新脱敏版本；不能在导出时静默改写原文来源或历史冻结数据。

## 显式材料上传预处理

DOC/WPS通过隔离UserInstallation的LibreOffice进程尝试转PDF；macOS转换环境复用原件预览的私有fontconfig，补入当前系统字体资源，并拒绝已知的错误中文字体回退。OFD通过本地OFDRW转PDF，PDF按大小/页数拆片，PNG/JPG/JPEG保留原字节进入清单。`provenance.json`记录源路径/SHA-256、转换器及版本、产物SHA-256/页数和抽查要求；任一失败只保留`failed.json`，不发布`manifest.json`。不自动安装转换器、上传或派任务，不覆盖、改名或删除原件。OFD转换件的数字签名效力不从原件继承。

PNG/JPG/JPEG提取只使用MinerU API原图直传，不转PDF，不调用或回退CLI/GLM-OCR；输出必须为单页结构。

`prepare-library-files.ts`的`prepareLibraryFiles()`由CLI `library files prepare`调用，详细产物与失败边界见上文。OFD安装入口见`scripts/runtime/ofd/README.md`。

本模块local队列模式的派发归属、指定ID领取、取消及恢复接入共享[执行队列](../execution-queue/README.md)；业务输入/结果契约保留，默认兼容模式不代表业务环境已切换。

冻结的`prepared_documents`用于逻辑分册导出：仅当正文和可用结构投影一致且正文纯空白时省略该分册，不修改来源快照；重复ID、缺失字段和非空结构矛盾仍拒绝。工作簿按同一分册文件名清单核对齐备性，非分册模式继续核对原材料覆盖。

脱敏DOCX的权威输入是通过摘要验证的冻结脱敏正文和结构。本机不存在原始PDF时，仅省略可选的原件备份；不回退原文、不补造原件。原文模式以及存在但指纹错误、路径越界的原件仍拒绝。

飞书交付调用材料导出时提供`expectedAuthoringInput`，生成前校验有效出题的来源绑定、原件集合的大小和SHA（共享题按冻结源artifact元数据比较）；普通DOCX导出仍独立于题目是否出题。核对回执与失败展示见[飞书交付](../publishing/README.md#飞书交付一致性核对)。

飞书交付的原件核对先读取完整冻结清单；新快照检查source_document产物ID、摘要及大小。字段不存在或为null的旧快照按冻结material ID/SHA核对并强制实读原件大小/摘要，不修改历史快照；存在非空产物ID但关联丢失或损坏不走兼容路径。

生命周期回调由[同步增强层](../lifecycle/README.md)统一注册，事件接入现有执行/保存边界；无注册时保持原流程。

项目差异统一从[lifecycle](../lifecycle/README.md)注册；提取provider、来源模式和脱敏执行仍属通用配置。步骤事件支持按主项目key订阅，只有实际存在key订阅时才查身份，不更改历史材料/任务快照。

本机明确新派发可在同一事务替代他机尚未开始的同范围待办；运行、结果未知和续作仍受保护，新派发失败则旧意图变更回滚。适用范围、共享状态兼容与验证边界见[执行队列的跨机准入](../execution-queue/README.md#他机未开始待办与本机明确派发)。

### 材料DOCX布局与来源顺序

材料DOCX布局由 `../lifecycle/material-docx.ts` 按主项目选择：默认 `separate`，按分册名称逐份输出且不额外插入正文标题；豆包高经济价值（兼容旧名豆包高经）对普通来源注册 `combined`。**新材料库选用材料快照**带`selected_materials`标记，导出器强制采用`separate`，即使项目注册了合册布局也逐文书输出。不能把豆包交付概括为所有来源固定一份附件。

题目冻结快照含材料整理结果时，按其中可见文书的顺序和边界导出；没有整理结果时，按该题原件顺序使用冻结正文/结构。整理结果存在但没有可见文书时明确拒绝，不回退整包正文。合并时复用与分册名相同的首标题，缺少时补文书边界标题；同名分册标“第N份”，`duplicate_of`关联标“重复件”，不因此删除正文或扫描件。合册只组合显示副本，不修改脱敏结果或冻结快照，也不重新OCR。`planMaterialDocxExports()`是实际导出与本地验收共用的纯计划入口；飞书上传与题目ID绑定见[交付流程](../publishing/README.md#材料附件生成上传与题目绑定)。

材料库图文 DOCX 为独立按需下载入口，仅用于冻结原文且已完成逐图整理的题目；纯文本 `exportCurrentMaterialDocx()` 的产物、缓存与交付路径不变。图文入口从冻结题目来源读取图片决定及内容寻址图片，不在导出时重做图片判断。PDF仅嵌入明确标记为独立插图且被整理保留的图片；旧PDF候选没有类别时保守排除，防止将整页扫描图和页饰再次拼接。详见[材料库可选图片候选](../material-library/README.md#可选图片候选与逐图整理)。
