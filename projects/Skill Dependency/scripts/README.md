# 本地交付

当前直交入口是 `GET /api/workflows/:id/skill-dependency-package`，由本目录 `direct-package.ts` 实现。出题成功后读取当前JSON及冻结附件，生成 `平台逐项填写指南.md`、`平台提交字段.json`、`instruction.md`、一份合并的 `附件1.docx`、逐来源 `input_files/attachment-N.md`、平台格式的 `rubric.json`、`golden_answer.md`、`golden_output/`、`skills/*.md`、`metadata.json` 和来源清单，作为ZIP下载。题面、逐题 Skill、Rubric 与参考成果的 `.md` 成果名同步投影为 `.docx`；XLSX 保持原格式。指南按 Siriser 出题页逐栏列明填写内容与上传路径；参考答案上传项只列题面要求的 `golden_output/` 文件，`golden_answer.md` 不额外上传。Golden Files 当前支持MD、TXT、CSV、TSV、JSON、DOCX和XLSX；文件题缺实际成果则拒绝。公共归档仍要求有效作答、评分及达标；本入口不修改其资格。

输入 DOCX 使用冻结来源索引及与豆包合册相同的结构拼接和渲染方法；`input_files/` 是逐来源文字投影。它们不等于原始PDF/DOCX字节，也不承诺图片保留。若项目方要求原格式或图片信息，须另行补齐同源文件映射和字节校验，不能把显示副本冒充原件。ZIP按请求临时生成，完成后清理临时文件；重新出题后旧下载不能再从入口取得。镜像自检、模型对照实验及平台上传需另行明确验收，不以本地打包成功代替。


## v2交付检查

`contract.ts` 是新增结构字段和确定性检查的共同来源，由生命周期出题 schema 和下载入口引用。新题保存 `delivery_contract`、`platform_metadata`、`platform_rubric`；公共 rubric 只作本地兼容投影，逐项 id/正文必须与平台项一致。下载输出平台字段、依赖检查、核验报告和全部产物SHA-256清单；字段名为本地规范化映射，尚未以平台上传回执验证。

下载检查输入、Skill、成果名称与题面引用，逐Skill依赖记录与评分点引用，评分权重/档位/占比，以及成果文件的可生成结构。`平台提交字段.json` 对应建题页字段，平台自动分配的题目编号不使用作者的本地追踪编号；分差范围须按目标和实测情况在平台选择。v1旧题缺少必要字段返回409；保留原出题结果，需重新出题取得新契约，不自动补写历史证据。该检查不进入出题保存过程。

公式使用显式 `{formula,cached_value}` 单元格对象；缓存值来自实际核算或为null。生成器写OOXML公式并要求打开时重算，不能替代计算引擎。`validation.json` 保留作者如实填写的未完成核验，不把 `not_performed` 当成结构错误；文件生成后仍须人工打开和检查版式、公式结果。报告明确区分程序结构检查与作者报告，`author_evidence_independently_verified=false`，不据文字记录证明实际工具执行或专业正确性。

现有两题的直交 ZIP 已由本地 API 生成，文件 CRC 与 DOCX 可打开性已核对。Siriser 的分阶段质检、评分和验收以页面实际回执为准；本地打包结果不替代平台通过。
