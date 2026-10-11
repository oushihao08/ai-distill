# ai-distill-workflow

| 文件 | 用途 |
| --- | --- |
| [SKILL.md](SKILL.md) | Codex执行入口、范围、步骤、停止与错误规则 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Skill/CLI/API/worker分层、数据流、状态边界及扩展方式 |
| [MAP.md](MAP.md) | 目录、流程、命令接口与修改位置地图 |
| README.md | 本目录说明及阅读导航 |

`SKILL.md` 是 Codex 操作入口，命令说明见 [CLI README](../cli/README.md)。命令使用 `bun run ai-distill`，可调整流程规则而不改变队列或模型执行器。

真实文件保存在根目录 `skill/`；`.agents/skills/ai-distill-workflow` 是指向这里的符号链接，仅用于 Codex 发现 Skill，不保存第二份内容。

本目录不放法律规则或当前题目的输入。Skill 的执行质量须用实际 Codex 操作另行验收；CLI 单元测试只证明命令契约。
