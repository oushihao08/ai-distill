<!-- 文件职责：说明 PDF 提取 provider 契约、独立 GLM-OCR／Document Mind 对照能力、MinerU API 优先流程及 CLI 回退实现。 -->
# PDF provider 契约

为 PDF 解析提供统一页级文本、稳定文档结构、来源指纹和 provider 身份。默认直连 MinerU v4 API；也可显式选择独立 GLM-OCR provider。两者的请求、响应转换、凭证和失败边界相互隔离。

## 文件职责

| 文件 | 说明 |
| --- | --- |
| `mineru-cli.ts` | MinerU CLI PDF 适配器：限制子进程环境、解析带页码 JSON 并支持超时和取消。 |
| `mineru-api.ts` | MinerU v4 API 适配器与 PDF API 优先／CLI 回退组合；DOCX、PNG、JPG、JPEG原件直接走API，图片校验单页结构且不进入回退链。 |

PDF 与 DOCX 请求显式启用 MinerU 的 `is_ocr`，以处理扫描页和仅含嵌入图片、没有 Word 文字节点的原件。结果仍须产生可提取正文；只有图片块的 ZIP 保持失败，不以图片路径充当正文。此变更只对加载新版代码后提交的新任务生效，历史失败任务不自动重投。供应商返回通用 `task_failed` 时没有文件级原因，不能将启用 OCR 视为已验证修复。
2026-11-06 实际核验：一份图片型 DOCX 的 MinerU 结果仅含 `image` 块；将其结果中的转换 PDF 再提交仍只得图片块，直接提交同一张嵌入 JPG 则得到文字块。此类结果现在按原块顺序逐张直传 MinerU OCR，任一图片无正文即以 `ocr_empty` 阻止整份发布；文字块使用含原块序号与图片摘要的稳定 ID，正式来源仍是完整 DOCX 原件。使用实际失败的高经8期2 case31 DOCX 独立调用新版适配器，返回 1 个逻辑页、15 个正文块、180 字；尚未作为完整材料包原子入库。图片请求统一显式设置 `is_ocr: true`。
| `mineru-credentials.ts` | 从进程环境选择主用或预备 MinerU 精准解析 API Token；只为新请求选凭证，不把密钥写入任务或诊断。 |
| `glm-ocr.ts` | 智谱 `layout_parsing` 独立适配器；严格核对页数，将全部带正文的布局块转换为当前 `DocumentBlock`，不经过 MinerU 回退链。 |
| `aliyun-docmind.ts` | 阿里云 Document Mind 文档解析大模型版客户端；复用官方 Node SDK 完成本地文件上传、轮询和 layout 分页收集，当前仅用于对照验证，不改变默认 provider。 |
| `types.ts` | PDF 提取供应商契约：统一页级文本、来源指纹和供应商标识。 |

## 数据流与依赖

types.ts 定义 PdfExtractionProvider／Result；默认 `MineruApiFirstPdfExtractor` 先调用 MinerU v4 API，经共享 `parseMineruJson()` 转成版本化文档结构及确定性文字投影；仅网络、5xx或云端任务提交前的超时失败且任务未取消时调用一次 CLI 适配器。文件上传成功并进入轮询后超时保留 `provider_timeout`，记录 `extraction.cli.fallback.skipped`，不向同一 MinerU 服务重复提交。设置 `PDF_EXTRACTION_PROVIDER=mineru-cli` 可显式强制 CLI。

设置 `PDF_EXTRACTION_PROVIDER=glm-ocr` 时只调用智谱 `layout_parsing`，使用 `ZHIPU_API_KEY`，不调用或回退 MinerU。单个PDF超过50 MiB或100页时在外发前拒绝，须先走现有材料预处理切片。GLM-OCR转换以当前`DocumentBlock`为唯一输出：`doc_title`／`paragraph_title`转标题，`table`转含合并关系的表格，`figure_title`转图注，`vision_footnote`转脚注，其余所有带`content`的块按原顺序转正文。表格HTML无法可靠解析时保留为正文块，禁止静默丢字；没有文字载荷的图片布局块不伪造占位符，因为当前稳定结构不保存图片载荷。DOCX仍走MinerU结构化接口，含DOCX的材料包必须同时配置`MINERU_KEY`。

Document Mind 对照客户端读取 `ALIYUN_DOCMIND_ACCESS_KEY_ID`、`ALIYUN_DOCMIND_ACCESS_KEY_SECRET` 和可选 `ALIYUN_DOCMIND_ENDPOINT`，输出 Markdown 并删除会过期的 OSS 临时图片链接。它尚未接入 `PDF_EXTRACTION_PROVIDER`，也不自动入库；真实调用仅证明供应商链路和当次文件结果。

## 维护边界

云端 MinerU 会接收 PDF，不是本地 OCR。直连 API 通过官方文件上传地址接口传输本地 PDF，任务完成后解析 ZIP 中的 `content_list.json`；轮询与下载设置限时，取消时不启动 CLI 回退。CLI 保留作为 API 失败后的路径。保留页数、页来源与异常，不仅取整段 Markdown；不要更改材料任务契约来适配单一供应商。

凭证池保留原有 `MINERU_KEY` 为主用 Token；预备 Token 可由 `MINERU_BACKUP_TOKEN` 提供，或存于 `<STORAGE_DIR>/secrets/mineru-backup.token`（目录0700、文件0600）。`MINERU_ACTIVE_TOKEN=primary|backup` 选择当前进程使用哪一份，缺省为 `primary`。API 与 CLI 共用同一选择；切换环境变量后须重启相应进程，已提交的供应商任务和现有 request-key 不会迁移或自动重试。两项都必须是 MinerU 精准解析 API Token，Access Key ID/Secret Access Key 不能当作 Bearer Token。对 `pending` 或结果未知的请求不自动换凭证重传；切换前应先确认旧任务终态。

本模块的 `*.test.ts` 保留既有验证意图；存在测试文件不表示本次运行。执行与授权遵循 [项目规则](../../../AGENTS.md)。

## MinerU 转换与诊断

PNG/JPG/JPEG原件检查点使用`mineru-open-api-first-structured-v4`，同时绑定原件SHA-256和具体图片格式，不得跨扩展名复用。图片原字节直传MinerU API，解析结果必须是单页，不转PDF或进入CLI/GLM-OCR回退链。

解析按原块顺序保存正文、标题层级、列表、表格行列/合并关系、公式、图注和脚注；文字投影从同一结构生成。HTML 表格仅作为输入解析，不在前端执行。新解析不为图片无文字、占位符、空结构块、未知块类型及表格降级生成推断式提示；空白页仍保留为可复查信号。图像路径和图像载荷不进入下游文档结构。

PDF转换标识为 `mineru-open-api-first-structured-v4`，DOCX为`mineru-docx-structured-v2`。MinerU页面附属文本仍按原文保留；新解析不为图片、占位符、未知类型及表格结构降级产出推断式issues，历史提取和缓存不回写。真实空白页及provider明确返回的处理异常仍保留给局部复查流程。入队可复用附件/配置相同的成功尝试，活动尝试保持去重；执行器另按来源与供应商/转换配置选择历史PDF产物缓存，再检查文件/结构/投影，不能把缓存查询等同于只选成功尝试。无结构旧缓存不会被新结构任务复用，重新提取入队时使该题下游结果失效，保留历史。`extraction.api.failed`、`extraction.cli.fallback.started` 与 `extraction.cli.fallback.skipped` 记录 provider 选择，不记录授权头、签名 URL 或正文。

HTML只在`html`字段、`type=html`的文字节点和表格HTML中转换：已配对的常用文字格式标签保留内部文字，`p/div`转段落边界、`br`转换行，实体单次解码一层。普通`text`字段、法规尖括号、未知标签及脚本/样式片段保留；不把全文当HTML。表格单元格保留未知尖括号文字；无法完整解析或存在无法归属的表外文字时保留完整原字段，不只保留已解析的部分，也不生成问题标记。无效实体码点保留，不导致整份文档失败。以上是解析器的中间结果；材料发布前由共享`scan-noise`文本清理移除剩余的中文/未知/错配标签并解码多层实体，保留标签内正文、金额日期、法规名称和比较符号。此清理也由脱敏计划编译复用，不在DOCX生成器里补处理，不追溯改写旧提取结果或快照。

每次 CLI 返回后，在 `STORAGE_DIR/.mineru-diagnostics/<diagnostic_id>/` 保存 `response.json`、`stderr.txt`、`metadata.json`（目录 0700，文件 0600）。元数据包含源 SHA-256、页数、转换版本、退出码和超时／取消状态；已知 MinerU 令牌会从输出中遮盖。失败发布不删除此目录。运行日志 `extraction.diagnostics_saved` 记录诊断编号，可按 workflow/attempt/call 定位；结构解析失败的步骤错误也包含编号。启动 CLI 前失败或诊断写盘失败可能没有完整证据。

这些文件可能包含未脱敏原文，仅供本机排障，不作为公开产物或模型输入；按本地私有数据管理，按需人工清理。无需重跑模型即可对照原始块与转换正文，但历史执行未保存的原始输出无法补回。

## DOCX API 入口

`MineruApiDocxExtractor` 复用 v4 上传、轮询和 ZIP 下载，使用 `parseMineruDocxJson` 将无 PDF 页码的内容列表转换成一个逻辑文本页，保留标题、段落、列表、表格顺序并忽略图片块。PDF 的 `parseMineruJson`、CLI 回退、页码和 OCR 缓存仍独立。

## 诊断、限时与缓存的精确范围

API下载结果后暂存`result.zip`及`response.json`；成功返回会删除本次API诊断目录，失败可保留已有文件。CLI正常返回后保存stdout/stderr/metadata并保留，启动前失败未必有完整诊断。不能声称所有成功API都保留原始响应，或将CLI诊断字段套给API。

结果ZIP通过`readMineruResultZip()`边读边累计字节，最多120MiB；超限、空响应或取消不进入解压，超限及取消会停止响应流。成功提取后的诊断目录删除失败仅记录安全错误及诊断ID，保留目录，不覆盖有效提取结果，也不因此触发CLI回退。此限制约束应用读取的累计字节，不保证网络栈预读或单个响应块的分配大小。

API的上传、轮询和下载由30分钟AbortSignal与轮询截止控制；`runUnzip`子进程接入API同一取消/截止信号，读取时累计检查输出上限，超限回收本次子进程。材料库外层按外部文件数累计30分钟预算并封顶24小时；CLI仍保持自身15分钟上限。到期按技术失败终结并释放执行槽，不自动重试。PDF预检仍依赖Poppler。

API在申请上传地址前建立私有诊断目录，`metadata.json`只保存来源摘要、页数、输入格式、云端batch ID、当前阶段及供应商状态，不保存令牌、上传/下载签名地址或正文；成功删除目录，失败保留以便只读查询原批次。安全日志持久化上传/轮询/下载阶段与供应商状态变化，同一排队状态不重复写日志；失败使用`reason_code`、`failure_phase`及`diagnostic_id`。结果下载失败还记录安全的`failure_stage`、HTTP状态或标准网络错误码，以区分请求、HTTP响应和响应流读取；不记录错误消息、响应正文或签名地址。`mineru-diagnostics.test.ts`用HTTP替身验证这些证据与敏感内容隔离。

API优先的回退资格按`permitsCliFallback()`分类（HTTP5xx、TypeError、云端任务提交前的指定超时/中止异常等），且外部取消时不回退；认证、无效JSON、结构解析或业务任务失败不靠CLI重传修复。文件上传成功后若轮询超时，API与CLI都使用同一MinerU服务，不重复上传并等待第二个超时。DOCX直接API，不走PDF回退。

PDF分片属于上层旧目录同步`../pdf-split.ts`，不是本模块自动给所有上传拆片。其缓存键绑定输入和限制，但已有分片复用仅检查文件列表/大小，不逐个重新计算内容摘要或页数；后续材料入库仍独立校验所选文件。

`mineru-cancellation.test.ts`在临时目录用FIFO、ZIP和自有子进程验证解压取消/流式大小边界及命令上下文取消；不调用真实MinerU。

该文件同时用合成响应流验证ZIP下载的大小边界、空响应、读取异常及等待期间取消；`mineru-diagnostics.test.ts`用合成ZIP、HTTP替身及文件删除故障验证提取成功不受诊断清理失败影响。均不证明真实供应商、OCR准确率或业务入库已验收。

### 结果下载代理规则

API 适配器下载结果 ZIP 时通过系统 `curl --noproxy '*'` 显式直连，不继承进程代理；继续执行 120 MiB 流大小限制、取消和原任务截止控制，运行环境需提供 curl；上传和轮询维持原有网络行为。CLI 子进程沿用受限环境，不传代理变量，并显式将 `cdn-mineru.openxlab.org.cn` 加入大小写 `NO_PROXY`。此规则针对已复现的本机代理访问 CDN 时 TLS/EOF 失败，不修改全局代理或材料处理配置。运行中的 worker 需重新加载代码后生效。

诊断事件 `extraction.api.upload_completed` 记录上传HTTP状态、文件字节及PDF页数；`extraction.api.poll_observed` 在状态变化或每60秒记录查询HTTP状态、轮询次数、结果条目数、供应商状态及返回的页进度。任务batch ID仅存私有诊断metadata，不记录凭证、文件名或结果下载URL。

失败诊断目录增加 `poll-latest.json`（每次查询覆盖：HTTP/业务码、安全关联ID、响应字段名、条目匹配情况、页进度、单次请求耗时）和 `failure-context.json`（最后请求是否悬挂、轮询次数、本地/父任务取消及超时预算）。不保存正文、文件名、签名URL或凭证。诊断日志修改只在新进程加载后生效，不能用旧进程任务声称验证。

供应商文件任务明确返回终态 `failed` 时，本次提取最多重新申请一次上传地址、重传同一原件并创建新批次；`pending`、`running`、未知回执和本地超时不重传。两次失败分别写入私有 `provider-failure-1.json` 与 `provider-failure-2.json`，保留批次/请求关联号、原件摘要、白名单数字错误码和截断并遮盖令牌及URL的 `err_msg`。结果 ZIP 遇到可识别的网络瞬断时最多重新下载两次，复用原成功批次，不重新上传。普通日志只记录错误码与诊断ID，不记录原始供应商消息。历史任务不会因代码修改补齐消息；诊断写盘失败也不改变原解析失败结果。读取这些私有文件时仍须核查消息是否含敏感材料，不直接公开。

### 第八期原子导入的请求与恢复边界（2026-11-07）

- 一个逻辑 case 的完整原件集合通过一次 `POST /api/material-library/imports` 提交，`request_key` 绑定这次提交。上传回执仅表示任务创建；任务成功且回读到正式 `package_id`、`revision_id` 才表示入库。后续脱敏与整理分别依赖上游正式成功结果。
- MinerU 请求是申请上传地址、PUT 原件、轮询该 `batch_id`、下载 ZIP 并解析结构。`pending` 只描述这次云端批次；本地轮询超时只证明本次等待终结，不能推断云端已失败。诊断目录的 `batch_id` 和任务 ID 用于区分新旧批次。曾观察到旧批次持续 `pending`，同一原件的新上传批次完成；不能从旧批次状态推断整个供应商不可用。
- 应用收到明确 `failed` 时，适配器在同次文件提取中最多新上传一次。整包导入已进入失败终态后，重新提取必须先核实任务、原件 SHA 和预处理映射，再用**新** `request_key` 提交**完整**文件集合；重复旧键只会回读旧失败任务。回执未知或任务仍运行时禁止盲重传。换上传批次不删除历史诊断，也不清理正式材料。
- JPEG 的 SOI/EOI 只用于扩展名边界检查。扫描仪在 EOI 后附加少量尾随数据仍可上传原字节，原件 SHA 不变；最终可解码性和正文质量以 MinerU 返回及逐页复核为准。真实签名不符、无 EOI、空正文或有字页被提成空页仍需阻塞，不能把任务成功等同于质量合格。
- 高并发旧批次长时间 `pending`、CDN 结果下载网络错误、云端 `failed`、本地 `provider_timeout`、正文空页是不同故障点。根据任务回执、诊断快照和正式版本分别定位；不要从监控页的本地运行数判断云端解析进度。
- 独立材料服务的 API 进程需要 `ATOMIC_IMPORT_EXECUTION_TARGET=server`，材料 worker 需要 `WORKER_MODE=materials` 和 `MATERIAL_EXECUTION_TARGET=server`。少任一设置都会使任务落到本机共享 local worker，或使材料 worker 启动失败。重载代码前后要回读新任务的 `execution_target` 与实际 worker 日志 PID；只重启 API 不代表旧 worker 已加载新解析器。
