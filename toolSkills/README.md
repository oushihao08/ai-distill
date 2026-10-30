# 项目工具 Skill

面向使用本仓库工具的 AI。这里维护工程操作 Skill，不放项目出题规则或材料输入；项目级发现入口使用 `.agents/skills/` 同名软链接，用户级 `~/.agents/skills` 不受影响。

| 目录 | 用途 |
| --- | --- |
| [ai-distill-scheduled-runner](ai-distill-scheduled-runner/SKILL.md) | 按用户指定间隔逐题对账、主动补位，推进材料、出题、作答、评分与有限返修 |
| [feishu-operations](feishu-operations/SKILL.md) | 通用飞书表格/字段/记录/视图、附件操作CLI与工具包，豆包交付复用；支持官方CLI透传 |
| [ai-trace-review](ai-trace-review/SKILL.md) | 审查明确处理残留、制作/语体问题及批量任务名称雷同；附带显式授权后的飞书任务名称改名工具，不鉴定AI来源、不冒充数据库同步 |

现有工作流契约见 [skill/](../skill/README.md)，工作流CLI参数见 [cli/](../cli/README.md)。本目录不实现第二套业务队列、模型执行器或并发配置；定时执行器记录写入 `.storage/automation-runs/`，飞书CLI身份、输入输出和副作用见各自说明。Skill存在不代表已启动、登录或完成远端验收。
