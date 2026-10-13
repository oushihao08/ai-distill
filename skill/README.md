# ai-distill-workflow

| 文件 | 用途 |
| --- | --- |
| [SKILL.md](SKILL.md) | Codex执行入口、范围、步骤、停止与错误规则 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Skill/API/worker分层、数据流、状态边界及扩展方式 |
| [MAP.md](MAP.md) | 目录、流程、API接口与修改位置地图 |
| README.md | 本目录说明及阅读导航 |

`SKILL.md` 是 Codex 操作入口，默认直接调用本机 HTTP API；[CLI README](../cli/README.md)仅说明可选命令行客户端，不是执行Skill的前置条件。

明确要求导出未达标题目时，使用 CLI 的固定导出命令；目录与文件规范见 [`assets/未达标题目/README.md`](../assets/未达标题目/README.md)。

真实文件保存在根目录 `skill/`；`.agents/skills/ai-distill-workflow` 是指向这里的符号链接，仅用于 Codex 发现 Skill，不保存第二份内容。

本目录不放法律规则或当前题目的输入。Skill 的执行质量须用实际 Codex 操作另行验收；API或CLI单元测试只证明各自契约。
