<!-- 文件职责：说明本机服务启动和部署脚本的入口及影响。 -->
# 运行脚本

| 脚本 | 用途与边界 |
| --- | --- |
| `start.sh`、`start.ts` | 从任意目录启动本地 API、worker 和前端；先检查 API/前端端口，已占用时退出，不复用或停止已有进程；不安装依赖、不迁移数据库。 |
| `start-iterm.sh` | macOS iTerm 启动入口；`npm run start:iterm` 调用此文件。仅复用本项目匹配的进程；当 `server/`、`shared/`、`config/`、根 `package.json`、`bun.lock` 或 `.env` 比 API/worker 新，且 monitor 心跳有效、工作流任务与材料库运行任务均确认归零时，向本项目旧 API/worker 发 `TERM` 后重启；状态缺失或不可用时拒绝重启。前端只按归属和命令复用，不独立检查源码新旧；不强制杀进程、不安装依赖、不迁移数据库。 |
| `deploy.sh`、`deploy-server.sh` | 从干净的 `main` 工作树部署与 `origin/main` 相同的提交；需要环境变量 `AI_DISTILL_DEPLOY_HOST`、`AI_DISTILL_DEPLOY_USER`、`AI_DISTILL_DEPLOY_DIR`、SSH 和生产操作授权。每次将本机 `.env` 经 SSH 传到服务器并替换服务器 `.env`（保留回滚副本）；SSH 用户必须是 root，服务器需 Docker Swarm。脚本会构建镜像、更新 API/worker 服务及调整存储目录权限；部署前检查 worker 空闲，不运行数据库迁移。成功后会显示本地访问用 SSH 隧道命令。 |

从仓库任意路径运行：`bash scripts/runtime/start.sh`。`start-iterm.sh` 可能在无运行任务时重启本项目 API/worker。部署示例：`AI_DISTILL_DEPLOY_HOST=<host> AI_DISTILL_DEPLOY_USER=root AI_DISTILL_DEPLOY_DIR=<absolute-path> ./scripts/runtime/deploy.sh`。部署会替换远端 `.env` 并更新服务，不能把它当作只传源码的操作；部署前核对本机配置确实应成为服务器配置，并按根 README 和仓库授权边界操作。

- `ofd/`：经显式授权安装OFDRW本地运行依赖，提供OFD整页转PDF桥接；不随服务启动自动安装。详见[OFD工具](ofd/README.md)。

`apply-local-queue-migration.ts`是047定向迁移工具：`bun scripts/runtime/apply-local-queue-migration.ts`默认只列全部未登记迁移与在途计数；显式`--apply`只应用047，拒绝其他必要迁移未齐；允许未归属在途任务继续，DDL仅等待短事务锁且超时回滚。不调用全量迁移器、不启动服务、不转移旧队列。旧消费者可以收尾未归属任务，但不会领取已归属任务；全部旧队列退役仍须逐机核对。队列启用与恢复见`server/execution-queue/README.md`。

`apply-authoring-defaults-migration.ts`默认只读列出待迁移清单；显式`--apply`仅应用048，其他必要迁移未齐时拒绝执行。需要单独数据库迁移授权，不重启服务或修改业务期次。
