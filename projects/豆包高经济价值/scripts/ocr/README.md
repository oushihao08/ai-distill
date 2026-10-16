<!-- 文件职责：索引豆包高经济价值项目的 OCR 试跑、抽查及题目流程核对脚本。 -->
# OCR 调查脚本

这些脚本绑定豆包高经济价值第五期的历史材料、题目或检查点，不是通用 OCR 命令。所有命令从仓库根目录运行。

| 脚本 | 用途与影响 |
| --- | --- |
| `run-flash-max-question-pdfs.ts` | 对项目题目 PDF 执行页级提取，复用检查点并在 `.storage/` 私有保存结果。 |
| `try-glm-ocr-question-folder.ts` | 将固定题目目录中的 PDF 发给 GLM-OCR，私有保存页级返回。 |
| `try-glm-ocr-sample.ts` | 按历史 attempt 读取指定 PDF 并调用 GLM-OCR。 |
| `review-glm-ocr-folder-samples.ts` | 对源图抽取首、中、末页，调用模型比较识别文本并保存抽查记录。 |
| `review-glm-ocr-quality.ts` | 对历史 OCR 样本的前六页进行模型复核。 |
| `audit-current-ocr.ts` | 抽查项目 OCR 检查点；会读取真实材料并调用模型。 |
| `compare-glm-ocr-page-cache.ts` | 对齐历史 GLM-OCR 与页缓存，计算文本相似度；相似度不是准确率。 |
| `verify-ocr-speed-quality.ts` | 对固定样本比较不同推理强度及缓存结果；会调用模型。 |
| `verify-real-question-folders.ts` | 调用本地 API 推进指定真实工作流，会改变业务状态。 |

运行前必须读脚本文件头的范围、固定标识和副作用说明，确认对应历史材料仍适用；不要因本目录索引而批量运行。输出可能包含案件中间文本，按脚本说明留在 `.storage/` 或受限证据文件中。
