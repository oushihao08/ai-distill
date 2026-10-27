# ai-distill-workflow

| 文件 | 用途 |
| --- | --- |
| [SKILL.md](SKILL.md) | Codex执行入口、范围、步骤、效率调度、停止与错误规则 |
| [REMOTE.md](REMOTE.md) | 从本机项目连接远程服务器并操作远程 CLI 的步骤 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Skill/API/worker分层、数据流、状态边界及扩展方式 |
| [MAP.md](MAP.md) | 目录、流程、API接口与修改位置地图 |
| README.md | 本目录说明及阅读导航 |

`SKILL.md` 是 Codex 操作入口：本机工作流默认直接调用本机 HTTP API；用户明确要求命令行时才使用 CLI。按执行池、就绪步骤和活动 attempt 滚动调度，等待期间处理独立工作。需要服务器执行旧工作流入库、人工声明处理、作答时，按 [远程 CLI 操作流程](REMOTE.md) 选择执行位置；CLI 参数见 [CLI README](../cli/README.md)。CLI 是 API 客户端，不是独立业务执行器。

共享材料库与期次的对象身份、来源冻结和使用记录见 `SKILL.md` 的“材料包与题目身份”，命令及服务端导航见 `MAP.md` 的“共享材料库与期次接口”。旧目录和旧材料包继续走兼容路径。项目出题内容规则仍在 `projects/<项目>/skill/`，不能由本操作 Skill 替代。

上传或提取前按`SKILL.md`的“材料上传与提取前检查”核对PDF大小和页数；超限时先复用既有本地预处理函数生成分片，再经API上传同包新版本。全局库上传/提取不会自动切割，不能由旧目录同步的自动切割能力推断新库也会处理。

[MAP.md](MAP.md#cli-工具地图) 逐项说明本机与远程能力、命令、实现文件及副作用；[ARCHITECTURE.md](ARCHITECTURE.md) 说明 Skill、CLI、API 和 worker 的边界。

未达标题目和指定题目复核包目前只有 CLI 本机文件导出实现，没有对应 HTTP 导出路由；只有用户明确要求命令行时才调用。输出路径、内容及覆盖保护由 `cli/failed-export.ts` 定义，首次导出时创建 `assets/未达标题目/` 目录；该目录是运行产物位置，不预置 README。

真实文件保存在根目录 `skill/`；`.agents/skills/ai-distill-workflow` 是指向这里的符号链接，仅用于 Codex 发现 Skill，不保存第二份内容。

本目录不放法律规则或当前题目的输入。Skill 的执行质量须用实际 Codex 操作另行验收；API或CLI单元测试只证明各自契约。
