<!-- 文件职责：说明 PDF 提取 provider 的适配接口和 CLI 实现。 -->
# PDF provider 契约

为 PDF 解析器提供统一页级文本、来源指纹和 provider 身份；当前封装 MinerU CLI。

## 文件职责

| 文件 | 说明 |
| --- | --- |
| `mineru-cli.ts` | MinerU CLI PDF 适配器：限制子进程环境、解析带页码 JSON 并支持超时和取消。 |
| `types.ts` | PDF 提取供应商契约：统一页级文本、来源指纹和供应商标识。 |

## 数据流与依赖

types.ts 定义 PdfExtractionProvider／Result；mineru-cli.ts 启动受限 CLI、等待结果并解析带页号 JSON。GLM provider 分流位于父模块 document.ts／jobs.ts。

## 维护边界

云端 MinerU 会接收 PDF，不是本地 OCR。保留页数、页来源与异常，不仅取整段 Markdown。超时／取消与环境隔离沿用模块实现。增加解析器前查现有接口；不要更改材料任务契约来适配单一供应商。

本模块的 `*.test.ts` 保留既有验证意图；存在测试文件不表示本次运行。执行与授权遵循 [项目规则](../../../AGENTS.md)。

## MinerU 转换与诊断

解析按原块顺序保留正文、表格 HTML、公式、表格／图片标题与脚注；HTML 不在前端执行。空块、无文字图片、`[NO TEXT]` 和无法转换的字段通过页级 issues 提示，不据此宣称识别完整，也不阻断部分结果入库。

转换标识为 `mineru-open-api-json-v2`。提取队列只复用附件和冻结配置相同的成功任务；活动任务保持去重。旧 v1 缓存不会用于 v2 新任务，重新提取入队时使该题下游结果失效，保留历史。

每次 CLI 返回后，在 `STORAGE_DIR/.mineru-diagnostics/<diagnostic_id>/` 保存 `response.json`、`stderr.txt`、`metadata.json`（目录 0700，文件 0600）。元数据包含源 SHA-256、页数、转换版本、退出码和超时／取消状态；已知 MinerU 令牌会从输出中遮盖。失败发布不删除此目录。运行日志 `extraction.diagnostics_saved` 记录诊断编号，可按 workflow/attempt/call 定位；结构解析失败的步骤错误也包含编号。启动 CLI 前失败或诊断写盘失败可能没有完整证据。

这些文件可能包含未脱敏原文，仅供本机排障，不作为公开产物或模型输入；按本地私有数据管理，按需人工清理。无需重跑模型即可对照原始块与转换正文，但历史执行未保存的原始输出无法补回。
