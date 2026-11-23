# 项目工具 Skill

面向操作本仓库的 Agent。仅存放工程操作 Skill，不放项目出题规则或案件原件；通过 `.agents/skills/` 同名软链接暴露。

| 目录 | 职责与边界 |
| --- | --- |
| [question-design-simulator](question-design-simulator/SKILL.md) | 出题点子对照推演、整版成题预测，以及同版豆包首次实测回验 |
| [doubao-answer-review](doubao-answer-review/SKILL.md) | 重出后逐题建立豆包工作任务并提交题面与案卷，或接管已有作答，监控、收件、核对耗时与回合并独立评分 |
| [materials-full-capacity-dispatch](materials-full-capacity-dispatch/SKILL.md) | 已授权材料批次的全量分页扫描、实时容量回读与持续补位 |
| [phase8-materials-full-capacity](phase8-materials-full-capacity/SKILL.md) | 第八期八个固定来源目录（132 逻辑包）入库/脱敏/整理双通道推进 |
| [feishu-operations](feishu-operations/SKILL.md) | 飞书表格/字段/记录/附件通用 CLI 与豆包人员分配；不定义评分达标规则 |
| [ai-trace-review](ai-trace-review/SKILL.md) | 审查模型处理残留、语体错位及任务重名；仅在显式授权后执行飞书改名 |

工作流主契约见 [skill/](../skill/README.md)，CLI 参数见 [cli/README.md](../cli/README.md)。
