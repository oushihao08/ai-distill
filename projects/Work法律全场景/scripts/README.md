<!-- 文件职责：索引 Work 项目级脚本入口、分类目录和维护边界。 -->
# Work 项目脚本

本目录集中管理 Work 法律全场景项目脚本。项目根目录保留项目说明、规则资料、skill、来源材料和成果索引；可执行脚本按入口职责放在本目录及其分类子目录。

| 路径 | 用途 | 调用方式 |
| --- | --- | --- |
| `delivery.ts` | 系统归档步骤的项目入口；按旧/新题目契约生成或投影成果，生成 Siriser 内容稿五件套，并尝试生成 Harbor 单题六件套和内部快照 | 由服务端归档流程调用；不直接接数据库；Harbor 映射或转换失败只将 Harbor 标为待处理，不阻断 Siriser 五件套归档 |
| `delivery.test.ts` | 用临时合成题目从交付入口验证五件套、六件套及快照目录生成 | `bun test 'projects/Work法律全场景/scripts/delivery.test.ts'`；不写业务数据库、不调用模型或平台 |
| `siriser/` | Siriser 内容稿五件套生成器及本次模拟专家成果提示词 | 见 [`siriser/README.md`](siriser/README.md)；五件套 golden_output 收录 Harbor 清单中的全部实际交付文件，不声称真人办理或平台验收 |
| `harbor/` | Harbor 单题导出、固定 Judge prompt、批次组包及固定脚本副本 | 见 [`harbor/README.md`](harbor/README.md) |

`delivery.ts` 由 `server/publishing/project-delivery.ts` 解析并执行。旧题目契约会使用当前项目 Agent 配置、冻结题面、Rubric 和附件生成带 AI 来源记录的内部成果，并核对本次网页检索事件；`work_legal_v1` 则直接投影题目内冻结的作者成果与检索记录，不在归档时重新调用模型或补做检索。两条路径都以题目冻结附件为输入，随后生成 Siriser 内容稿五件套；Harbor 单题六件套是独立的可选转换，转换失败只记录待处理状态。Harbor 包的 `submission_ready` 固定为 `false`，不代表 Oracle、Judge、三模型、人工或平台验收通过。来源记录如实保留，不冒充真人专家。变更入口行为时同步检查该解析器、[发布模块说明](../../../server/publishing/README.md)及[项目说明](../README.md)。

上述Agent生成路径适用于历史题目；`work_legal_v1`直接读取作者冻结的完整成果与检索，不再次创作答案。新结构映射保留required、专业知识和附件别名，工具集合对应导出器实际预装入口；Harbor原始rubrics.json平铺规范字段，内部criterion/rule包装不外传。外部登记身份、正式二级分类、否决接口与累计计分转换仍须分别解决，不能据字段单测通过宣称新契约已经完成正式交付。

## Siriser归档与Harbor可选转换

当前`delivery.ts`先独立生成Siriser五件套。新Work输出确认稿JSON目录和ZIP；Harbor身份不必提供，后续转换失败写`Harbor生成状态.json`为pending，不影响正确五件套与归档。身份已提供且转换可无损完成才生成Harbor预备包；不删除Veto或改变累计规则。私有快照和状态文件不装入上传ZIP。

独立delivery脚本可按workflow与同次脱敏artifact身份通过既有只读HTTP接口补齐结构并验证摘要。运行中进程是否包含某项 API 行为，须核对进程实际加载的版本；归档成功不代表平台已提交或验收。

归档快照按内容 SHA-256 写入 `快照历史/` 保留旧版；`题目快照.json` 原子更新为本次达标来源。重评导致来源改变不再被误判为覆盖冲突；同摘要历史文件仍校验内容一致。历史快照为私有产物，不装入五件套。
