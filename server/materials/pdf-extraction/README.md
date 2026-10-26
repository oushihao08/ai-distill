<!-- 文件职责：说明 PDF 提取 provider 契约、MinerU API 优先流程及 CLI 回退实现。 -->
# PDF provider 契约

为 MinerU PDF 解析提供统一页级文本、来源指纹和 provider 身份；默认直连 MinerU v4 API，仅网络、5xx或超时失败时回退一次到本机 `mineru-open-api` CLI。

## 文件职责

| 文件 | 说明 |
| --- | --- |
| `mineru-cli.ts` | MinerU CLI PDF 适配器：限制子进程环境、解析带页码 JSON 并支持超时和取消。 |
| `mineru-api.ts` | MinerU v4 API 适配器与 API 优先／CLI 回退组合；管理上传、轮询、结构读取、超时和取消。 |
| `types.ts` | PDF 提取供应商契约：统一页级文本、来源指纹和供应商标识。 |

## 数据流与依赖

types.ts 定义 PdfExtractionProvider／Result；默认 `MineruApiFirstPdfExtractor` 先调用 MinerU v4 API，经共享 `parseMineruJson()` 转成版本化文档结构及确定性文字投影；仅网络、5xx或超时失败且任务未取消时调用一次 CLI 适配器。设置 `PDF_EXTRACTION_PROVIDER=mineru-cli` 可显式强制 CLI。API 与 CLI 都需 `MINERU_KEY`，不支持 GLM provider 分流。

## 维护边界

云端 MinerU 会接收 PDF，不是本地 OCR。直连 API 通过官方文件上传地址接口传输本地 PDF，任务完成后解析 ZIP 中的 `content_list.json`；轮询与下载设置限时，取消时不启动 CLI 回退。CLI 保留作为 API 失败后的路径。保留页数、页来源与异常，不仅取整段 Markdown；不要更改材料任务契约来适配单一供应商。

本模块的 `*.test.ts` 保留既有验证意图；存在测试文件不表示本次运行。执行与授权遵循 [项目规则](../../../AGENTS.md)。

## MinerU 转换与诊断

解析按原块顺序保存正文、标题层级、列表、表格行列/合并关系、公式、图注和脚注；文字投影从同一结构生成。HTML 表格仅作为输入解析，不在前端执行。空块、无文字图片、`[NO TEXT]`、未知类型和无法转换的表格通过页级 issues 提示，不据此宣称识别完整，也不阻断部分结果入库。图像路径和图像载荷不进入下游文档结构。

转换标识为 `mineru-open-api-first-structured-v3`。V1原始结果中的header/footer/page_number/aside_text按原文保留，不误报未知类型；无文字图片、占位符及真正未知类型仍报告issues。入队可复用附件/配置相同的成功尝试，活动尝试保持去重；执行器另按来源与供应商/转换配置选择历史PDF产物缓存，再检查文件/结构/投影，不能把缓存查询等同于只选成功尝试。无结构旧缓存不会被新结构任务复用，重新提取入队时使该题下游结果失效，保留历史。`extraction.api.failed` 与 `extraction.cli.fallback.started` 记录 provider 切换，不记录授权头、签名 URL 或材料正文。

每次 CLI 返回后，在 `STORAGE_DIR/.mineru-diagnostics/<diagnostic_id>/` 保存 `response.json`、`stderr.txt`、`metadata.json`（目录 0700，文件 0600）。元数据包含源 SHA-256、页数、转换版本、退出码和超时／取消状态；已知 MinerU 令牌会从输出中遮盖。失败发布不删除此目录。运行日志 `extraction.diagnostics_saved` 记录诊断编号，可按 workflow/attempt/call 定位；结构解析失败的步骤错误也包含编号。启动 CLI 前失败或诊断写盘失败可能没有完整证据。

这些文件可能包含未脱敏原文，仅供本机排障，不作为公开产物或模型输入；按本地私有数据管理，按需人工清理。无需重跑模型即可对照原始块与转换正文，但历史执行未保存的原始输出无法补回。

## DOCX API 入口

`MineruApiDocxExtractor` 复用 v4 上传、轮询和 ZIP 下载，使用 `parseMineruDocxJson` 将无 PDF 页码的内容列表转换成一个逻辑文本页，保留标题、段落、列表、表格顺序并忽略图片块。PDF 的 `parseMineruJson`、CLI 回退、页码和 OCR 缓存仍独立。

## 诊断、限时与缓存的精确范围

API下载结果后暂存`result.zip`及`response.json`；成功返回会删除本次API诊断目录，失败可保留已有文件。CLI正常返回后保存stdout/stderr/metadata并保留，启动前失败未必有完整诊断。不能声称所有成功API都保留原始响应，或将CLI诊断字段套给API。

结果ZIP通过`readMineruResultZip()`边读边累计字节，最多120MiB；超限、空响应或取消不进入解压，超限及取消会停止响应流。成功提取后的诊断目录删除失败仅记录安全错误及诊断ID，保留目录，不覆盖有效提取结果，也不因此触发CLI回退。此限制约束应用读取的累计字节，不保证网络栈预读或单个响应块的分配大小。

API的上传/轮询/下载由30分钟AbortSignal与轮询截止控制；`runUnzip`子进程接入API同一取消/截止信号，读取时累计检查输出上限，超限回收本次子进程；没有额外放宽时限。CLI自身及本地外层均设置30分钟；PDF预检还依赖Poppler。文档中的时限不保证所有子进程总耗时严格封顶。

API在申请上传地址前建立私有诊断目录，`metadata.json`只保存来源摘要、页数、输入格式、云端batch ID、当前阶段及供应商状态，不保存令牌、上传/下载签名地址或正文；成功删除目录，失败保留以便只读查询原批次。安全日志持久化上传/轮询/下载阶段与供应商状态变化，同一排队状态不重复写日志；失败使用`reason_code`、`failure_phase`及`diagnostic_id`。`mineru-diagnostics.test.ts`用HTTP替身验证这些证据与敏感内容隔离。

API优先的回退资格按`permitsCliFallback()`分类（HTTP5xx、TypeError、指定超时/中止异常等），且外部取消时不回退；认证、无效JSON、结构解析或业务任务失败不靠CLI重传修复。DOCX直接API，不走PDF回退。

PDF分片属于上层旧目录同步`../pdf-split.ts`，不是本模块自动给所有上传拆片。其缓存键绑定输入和限制，但已有分片复用仅检查文件列表/大小，不逐个重新计算内容摘要或页数；后续材料入库仍独立校验所选文件。

`mineru-cancellation.test.ts`在临时目录用FIFO、ZIP和自有子进程验证解压取消/流式大小边界及命令上下文取消；不调用真实MinerU。

该文件同时用合成响应流验证ZIP下载的大小边界、空响应、读取异常及等待期间取消；`mineru-diagnostics.test.ts`用合成ZIP、HTTP替身及文件删除故障验证提取成功不受诊断清理失败影响。均不证明真实供应商、OCR准确率或业务入库已验收。
