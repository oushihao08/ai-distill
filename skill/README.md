# ai-distill-workflow

| 文件 | 用途 |
| --- | --- |
| [SKILL.md](SKILL.md) | Codex执行入口、范围、步骤、停止与错误规则 |
| [REMOTE.md](REMOTE.md) | 从本机项目连接远程服务器并操作远程 CLI 的步骤 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Skill/API/worker分层、数据流、状态边界及扩展方式 |
| [MAP.md](MAP.md) | 目录、流程、API接口与修改位置地图 |
| README.md | 本目录说明及阅读导航 |

`SKILL.md` 是 Codex 操作入口：本机工作流默认直接调用本机 HTTP API；用户指定 CLI 或需要服务器执行入库、脱敏、作答时，按 [远程 CLI 操作流程](REMOTE.md) 选择执行位置，再按 [CLI README](../cli/README.md) 查命令参数。CLI 是 API 客户端，不是独立业务执行器。

材料包多题模式的对象识别与步骤边界见 `SKILL.md` 的“材料包与题目身份”，对应 API、CLI 路径见 `MAP.md` 的“材料包多题接口”。项目出题内容规则仍在 `projects/<项目>/skill/`，不能由本操作 Skill 替代。

[MAP.md](MAP.md#cli-工具地图) 逐项说明本机与远程能力、命令、实现文件及副作用；[ARCHITECTURE.md](ARCHITECTURE.md) 说明 Skill、CLI、API 和 worker 的边界。

明确要求导出未达标题目时，使用 CLI 的固定导出命令；目录与文件规范见 [`assets/未达标题目/README.md`](../assets/未达标题目/README.md)。

真实文件保存在根目录 `skill/`；`.agents/skills/ai-distill-workflow` 是指向这里的符号链接，仅用于 Codex 发现 Skill，不保存第二份内容。

本目录不放法律规则或当前题目的输入。Skill 的执行质量须用实际 Codex 操作另行验收；API或CLI单元测试只证明各自契约。
