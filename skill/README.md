# ai-distill-workflow

本目录为仓库唯一工作流操作 Skill（`.agents/skills/ai-distill-workflow` 软链接至此），与 `projects/<项目>/skill/` 的出题内容规则严格分离。

| 文件 | 用途 |
| --- | --- |
| [SKILL.md](SKILL.md) | Agent 执行入口：通道选择、材料/题目不变量、分页与轻量读取、封存态/定制步骤、五大项目交付矩阵与恢复规则 |
| [MAP.md](MAP.md) | 步骤 ordinal、服务端 HTTP 路由、CLI 命令组与源码修改定位地图 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Skill / CLI / API / worker 分层、状态判定边界与扩展准则 |
| [REMOTE.md](REMOTE.md) | 经 SSH 隧道调用远程服务器执行旧工作流材料处理与模型作答的前置及步骤 |

核心边界：默认调用本机 `http://127.0.0.1:3700` HTTP API，用户明确要求命令行时使用 CLI（`bun run ai-distill [<前缀>] --help`）；任何路径均禁止直连 PostgreSQL 或 SQLite 改写状态。
