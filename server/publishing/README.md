# 达标题目归档

本模块校验当前达标版本，调用项目交付入口并记录 ordinal 8 与归档/撤回事件。归档、文件下载、外部平台提交和平台验收分别记录；归档成功不能冒记为平台提交。

| 文件 | 职责与入口 |
| --- | --- |
| `jobs.ts` | `publishWorkflow()` 复核当前题目/答案/评分/达标与文件摘要，执行项目交付并记录归档；`readSiriserArchive()` 下载当前有效 Work 五件套；撤回接口保留历史事件。 |
| `project-delivery.ts` | `resolveProjectDelivery()` 解析主项目 `scripts/delivery.ts`（兼容旧根目录入口）；`runProjectDelivery()` 向独立子进程发送已验证快照；`DeliveryInput` 是交付脚本输入契约。无脚本时使用明确的空实现。 |
| `work-simulation.ts` | Work 标准成果准备：`work_legal_v1` 直接投影作者冻结成果及检索记录；旧题才走 Agent 生成/事件核对与缓存。保留真实来源信息，不把作者声明冒记为本次归档检索事件。 |
| `jobs.test.ts` | 验证归档版本、材料/评分绑定、脚本重用、来源模式、撤回与包下载校验；注入执行器不证明真实模型或外部平台成功。 |

## 输入与数据流

`publishWorkflow()` 锁定题目，读取当前模型集合与达标配置，校验 ordinal 4–7、达标结果及依据摘要、逐模型答案/评分绑定、题目产物和材料摘要。共享材料题通过 `question-materials.ts` 读取该题冻结的脱敏或已提取原文；旧目录题读取自己的成功脱敏结果。归档验证作者冻结的 Skill 清单自洽，不要求历史题目匹配后来修改的当前 Skill。

Work 准备标准成果时释放数据库事务，在 Agent 槽位范围调用 `getOrGenerateWorkSimulation()`，随后重开事务核对题目、模型集合和达标依据未变。`work_legal_v1` 分支只投影作者快照，不再调用模型；旧格式的生成受项目模型配置、执行时限和检索证据约束。不要把外层槽位等待当成发生了真实模型调用。

项目交付入口接收私有题包、达标摘要、当前冻结材料文字及可用结构；不向子进程传数据库/供应商凭证。相同来源/脚本/身份摘要可重用归档记录，但再次归档仍会执行项目脚本。脚本是受信任代码，不是 OS 沙箱；文件和平台副作用不随数据库回滚，脚本必须按来源摘要实施幂等写入。

## 五件套、DOCX 和下载

Work 交付脚本先生成 Siriser 五件套（三份 JSON、`input_files`、`golden_output`）及 ZIP。Harbor `task_id/org` 是可选后续转换参数，提供时仍校验；未提供不阻断五件套。这里不能替用户推断真实平台身份。

Work 的 `input_files` 输出 DOCX；与题目来源模式对应的可用结构由受验证的材料索引读取。脱敏模式不允许把未脱敏结构混入载荷；原文模式按该题显式冻结的原文来源交付。旧无结构文本走明确的 Markdown 转 DOCX 兼容路径，不能宣称保留了不存在的 MinerU 结构。

HTTP 归档入口还会生成来源模式对应的附件 DOCX 和单题 Excel，通常位于 `assets/out/附件库/<主项目>/<期数>/<题目>/成果/`；完整项目 Excel 是 reporting 的独立操作。DOCX/Excel 失败不回滚已提交的归档状态，重试必须核对当前归档版本。单题 Excel 不代替五件套中的专业成果。

`GET /api/workflows/:id/siriser-zip` 和 CLI `siriser download` 重新验证当前达标依据、冻结规则、题面/Rubric版本、已归档脚本摘要与包索引的一致性、路径及 ZIP 摘要；下载不重新计算当前交付脚本摘要，脚本变更应重新归档。它们只下载文件，不上传 Siriser。旧目录因期次改名仍按已保存归档路径定位，不搬动旧成果。

独立 Work `delivery.ts` 保留旧 API 载荷的只读结构补全路径：使用同工作流、同脱敏 attempt 的现有 HTTP 索引，核对正文与结构摘要后补齐；新载荷已有结构时不再查询。该兼容路径不直连数据库、不修改归档资格。

## 事件与维护边界

归档将项目/题目身份、材料来源、原件和冻结附件摘要保存到归档尝试及 `workflow_publication_events`。`POST /api/workflows/:id/withdraw-archive` 仅撤回当前归档状态，保留尝试、事件和文件；再次归档仍重新校验。材料库使用查询展示这些引用，不代替主项目永久材料使用账中的 `in_use/submitted` 事实。

题面、Rubric、答案、评分或归档依据改变后重新校验，不复用失效成果。项目 Skill 的当前绑定修改不会改写历史题目冻结快照；项目导出可标记过期。有关输入隔离与来源读取的权威入口分别为 [评分](../scoring/README.md)、[材料来源](../question-materials.ts) 和 [材料库](../material-library/README.md)。
