<!-- 文件职责：索引系统级脚本目录及其用途分组；项目专用脚本由各自项目维护。 -->
# 系统脚本索引

根 `scripts/` 只管理跨项目或系统运行脚本，按用途分目录。项目专用脚本统一放在 `projects/<主项目>/scripts/`，并由项目自己的 README 索引；不得把项目逻辑散落到这里。

| 目录 | 内容 |
| --- | --- |
| [`runtime/`](runtime/README.md) | 本地服务启动和部署脚本；`package.json` 的 `start:iterm` 直接调用 `runtime/start-iterm.sh` |
| [`diagnostics/`](diagnostics/README.md) | 只读结构化日志查询等诊断工具 |
| [`verification/`](verification/README.md) | 跨项目集成、隔离数据库、模型接口和系统模块验收脚本；按脚本说明确认是否会触发真实 API 或写入证据 |

豆包高经济价值和 Work 法律全场景的项目专用工具分别见[豆包脚本索引](../projects/豆包高经济价值/scripts/README.md)和[Work 脚本索引](../projects/Work法律全场景/scripts/README.md)。

## 维护约定

- 新增脚本时先判断归属：系统级放入上述用途目录；某个项目专用的放入对应项目目录下的用途子目录。
- 每个脚本目录的 README 说明入口、用途和运行影响。脚本顶部的路径、文档命令、`package.json`／`tsconfig.json` 配置须与实际位置一致。
- 部分验证脚本会把结果写入 `docs/evidence/`；该目录是历史产物位置，不是当前流程或规则来源。当前行为以脚本源码、参数解析和本索引为准；本任务不读取或改写 `docs/`。
- 不要批量执行验收脚本。测试、模型调用、远端数据库写入或部署均按仓库授权边界单独确认。
