<!-- 文件职责：索引 Work 项目级脚本入口、分类目录和维护边界。 -->
# Work 项目脚本

本目录集中管理 Work 法律全场景项目脚本。项目根目录保留项目说明、规则资料、skill、来源材料和成果索引；可执行脚本按入口职责放在本目录及其分类子目录。

| 路径 | 用途 | 调用方式 |
| --- | --- | --- |
| `delivery.ts` | 系统归档步骤的项目入口；生成 AI 模拟专家成果、Siriser 内容稿五件套、Harbor 单题六件套及内部快照 | 由服务端归档流程调用；模型生成由发布模块准备输入，不直接接数据库；缺 Harbor 映射或产物格式不支持时归档失败 |
| `delivery.test.ts` | 用临时合成题目从交付入口验证五件套、六件套及快照目录生成 | `bun test 'projects/Work法律全场景/scripts/delivery.test.ts'`；不写业务数据库、不调用模型或平台 |
| `siriser/` | Siriser 内容稿五件套生成器及本次模拟专家成果提示词 | 见 [`siriser/README.md`](siriser/README.md)；五件套 golden_output 收录 Harbor 清单中的全部实际交付文件，不声称真人办理或平台验收 |
| `harbor/` | Harbor 单题导出、固定 Judge prompt、批次组包及固定脚本副本 | 见 [`harbor/README.md`](harbor/README.md) |

`delivery.ts` 由 `server/publishing/project-delivery.ts` 解析并执行。Work 归档会使用当前项目 Agent 配置、冻结题面、Rubric 和脱敏附件生成 AI 模拟内容，并要求可核对的本次网页检索事件；随后按 `project_context.harbor` 的精确文件清单组装 Siriser 内容稿五件套和 Harbor 单题六件套。Harbor 包的 `submission_ready` 固定为 `false`，不代表 Oracle、Judge、三模型、人工或平台验收通过。AI 身份如实标记，不冒充真人专家。变更入口行为时同步检查该解析器、[发布模块说明](../../../server/publishing/README.md)及[项目说明](../README.md)。

上述Agent生成路径适用于历史题目；`work_legal_v1`直接读取作者冻结的完整成果与检索，不再次创作答案。新结构映射保留required、专业知识和附件别名，工具集合对应导出器实际预装入口；Harbor原始rubrics.json平铺规范字段，内部criterion/rule包装不外传。外部登记身份、正式二级分类、否决接口与累计计分转换仍须分别解决，不能据字段单测通过宣称新契约已经完成正式交付。

## Siriser优先的归档行为（2026-10-16）

当前`delivery.ts`先独立生成Siriser五件套。新Work输出确认稿JSON目录和ZIP；Harbor身份不必提供，后续转换失败写`Harbor生成状态.json`为pending，不影响正确五件套与归档。身份已提供且转换可无损完成才生成Harbor预备包；不删除Veto或改变累计规则。私有快照和状态文件不装入上传ZIP。

本地旧API进程无需重启即可使用更新的独立delivery脚本：脚本按workflow与同次脱敏artifact身份通过既有只读HTTP接口补齐结构并验证摘要。2026-10-16合伙L5已实际归档成功，包内输入为结构化DOCX；此证据不代表平台已提交或验收。

归档快照按内容 SHA-256 写入 `快照历史/` 保留旧版；`题目快照.json` 原子更新为本次达标来源。重评导致来源改变不再被误判为覆盖冲突；同摘要历史文件仍校验内容一致。历史快照为私有产物，不装入五件套。
