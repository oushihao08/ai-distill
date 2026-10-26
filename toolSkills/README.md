# 项目工具 Skill

面向使用本仓库工具的 AI。这里维护工程操作 Skill，不放项目出题规则或材料输入；项目级发现入口使用 `.agents/skills/` 同名软链接，用户级 `~/.agents/skills` 不受影响。

| 目录 | 用途 |
| --- | --- |
| [ai-distill-scheduled-runner](ai-distill-scheduled-runner/SKILL.md) | 按用户指定间隔逐题对账、主动补位，推进材料、出题、作答、评分与有限返修 |

现有工作流契约见 [skill/](../skill/README.md)，CLI参数见 [cli/](../cli/README.md)。本目录不实现第二套业务队列、模型执行器或并发配置；运行时记录写入 `.storage/automation-runs/`。Skill文件存在不代表定时任务已启动，执行需要明确目标和范围。
