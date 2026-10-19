<!-- 文件职责：说明 Work Harbor 工具、模板文件和输出边界。 -->
# Work Harbor 工具

本目录只放 Harbor 转换和打包相关工具，不承担通用项目归档。

| 文件／目录 | 职责 |
| --- | --- |
| `batch-package.ts` | 校验已完成的单题题包并生成批次目录与 ZIP |
| `export-accepted-task.ts` | 从已提供的题面、完整 Harbor 元数据、附件、逐件成果、评分提示模板和固定脚本组装单题六件套；不生成法律成果 |
| `judge-prompt-template.md` | 固定 Judge 提示词；以项目交付规范的 Material map、公平性、参考答案政策和工具提示要求编写，来源尚未与项目方单独提供的 prompt 原件核验 |
| `official/tests/` | 当前登录态钉钉规范页面 A.1/A.2 代码块的固定脚本副本；SHA-256 与当前页面代码块一致，未取得独立下载的原始附件 |
| `*.test.ts` | 导出器行为检查；运行授权依照仓库 `AGENTS.md` |

运行批次组包：

```sh
bun projects/Work法律全场景/scripts/harbor/batch-package.ts /绝对路径/manifest.json
```

导出器要求显式提供本题 `project_context` 映射后的必填字段、精确交付物列表、输入材料说明和完整 Judge prompt 模板。当前归档接口尚不接收 Skill 原件，因此 `skill_set` 非空时拒绝生成，避免元数据声称提供 Skill 而 `environment/skills/` 缺失。独立否决项与无封顶累计扣分当前没有已确认的无损评分映射，遇到时拒绝生成。导出器会校验 `test.sh` 与 `finalize.py` 的 SHA-256 是否匹配 2026-10-14 从当前登录态钉钉规范页面 A.1/A.2 代码块读取的摘要；这确认本地文件与当前页面代码块一致，不代表取得了独立下载原件，也不代表整个题包通过验收。生成结果是内部预备包，旁置状态文件固定标记 `submission_ready=false`。

`scripts/delivery.ts` 已接入单题 Harbor 六件套生成：要求题目第一条普通 Rubric 的 `metadata.project_context.harbor` 提供真实 `task_id`、`org`、全部元数据、逐份输入说明和精确交付物清单；旧题目契约由归档模型逐件生成清单要求的 DOCX、XLSX、MD、TXT、CSV 或 JSON 文件，新 `work_legal_v1` 契约读取作者冻结成果，程序校验文件集合并按声明格式转换。缺映射、路径不安全、格式不支持或 Rubric 无损映射失败时，Harbor 六件套单独记为待处理；Siriser 五件套与内部归档不因此失败，也不会复制一份成果凑成多个文件。检索记录不足会使旧契约的成果生成失败；新契约则使用作者冻结的检索记录并按 `work-simulation.ts` 的约束校验。

单题包状态仍固定 `submission_ready=false`。固定 `test.sh`、`finalize.py` 的摘要与当前登录态钉钉规范页面代码块一致；`judge-prompt-template.md` 是项目依据交付规范编写的固定模板，尚未与项目方单独提供的 prompt 原件核验。Oracle、Judge 运行、三模型评测、人工质检、负责人验收及平台提交均未由归档步骤执行。批次打包只接收已完成的单题目录，并比较 manifest 指定脚本与包内副本，不验证 manifest 文件来源。本 README 只说明工具行为，不替代项目交付规范；当前 checkout 不包含该业务规范文件，具体口径须回到项目方当前授权资料核对。
