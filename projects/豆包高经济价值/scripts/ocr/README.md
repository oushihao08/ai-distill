<!-- 文件职责：索引豆包高经济价值项目的 OCR 试跑、抽查及题目流程核对脚本。 -->
# OCR 调查脚本

这些脚本绑定豆包高经济价值第五期的历史材料、题目或检查点，不是通用 OCR 命令。所有命令从仓库根目录运行。

| 脚本 | 用途与影响 |
| --- | --- |
| `run-flash-max-question-pdfs.ts` | 固定扫描题目1、题目3的 PDF；使用 GLM-5.3-Flash max、两路并发及逐页检查点。原文提取和检查点写入 `.storage/` 私有目录。 |
| `try-glm-ocr-question-folder.ts` | 将固定题目1、题目3的 PDF 发给 GLM-OCR；原始响应写入 `.storage/`，汇总另写 `docs/evidence/`。返回文本未脱敏。 |
| `try-glm-ocr-sample.ts` | 按固定历史 attempt 和题目3文书查询数据库、读取 PDF 并调用 GLM-OCR；原始响应以私有文件权限写入 `.storage/`。 |
| `review-glm-ocr-folder-samples.ts` | 对固定样本的首、中、末页渲染源图并调用模型；逐页记录写 `.storage/`，汇总写 `docs/evidence/`，可能含原文摘录。 |
| `review-glm-ocr-quality.ts` | 对固定历史 attempt 的 OCR 前六页做模型复核；结果计数及材料哈希写入 `docs/evidence/`。不是人工验收。 |
| `audit-current-ocr.ts` | 读取固定 attempt 的真实材料和 OCR 检查点，渲染抽样原页并调用模型；报告写入 `docs/evidence/`，issue 记录可能含原文/OCR 摘录。 |
| `compare-glm-ocr-page-cache.ts` | 查询固定历史 attempt、对齐 GLM-OCR 与 max 页缓存并计算文本相似度；摘要写入 `docs/evidence/`，相似度不是准确率。 |
| `verify-ocr-speed-quality.ts` | 对题目1、题目3固定历史样本比较 low/high 与 max 缓存；会调用模型，原始文本写 `.storage/`，结果摘要写 `docs/evidence/`。 |
| `verify-real-question-folders.ts` | 固定读取本地 3700 API 上的题目1、题目3；会 POST `/load-rules`、下载脱敏 Markdown、每15秒轮询活动尝试直到终态，并写报告到 `docs/evidence/`。它会改变工作流，不是只读检查。 |

脚本含固定项目、题目、attempt、模型和输出路径；部分会向外部模型发送未脱敏原件，`verify-real-question-folders.ts` 会改变数据库中的工作流状态。运行前逐项确认真实输入、模型外发授权和副作用；不要因本目录索引而批量运行。

输出边界必须区分：`.storage/` 下的页文本、OCR 完整响应和检查点可能含未脱敏正文；多份脚本把 JSON 汇总写到仓库内 `docs/evidence/`，其中可能有源文书摘录、OCR 摘录、文件名、材料哈希或工作流标识。`docs/evidence/` 不等同于私有存储，也不能据目录名推断已脱敏。脚本写出的历史记录不构成完整人工校验或验收。
