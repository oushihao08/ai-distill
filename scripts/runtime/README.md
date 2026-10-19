<!-- 文件职责：说明本机服务启动和部署脚本的入口及影响。 -->
# 运行脚本

| 脚本 | 用途与边界 |
| --- | --- |
| `start.sh`、`start.ts` | 从任意目录启动本地 API、worker 和前端；先检查 API/前端端口，已占用时退出，不复用或停止已有进程；不安装依赖、不迁移数据库。 |
| `start-iterm.sh` | macOS iTerm 启动入口；`npm run start:iterm` 调用此文件。仅复用本项目匹配的进程；当 `server/`、`shared/`、`config/`、根 `package.json`、`bun.lock` 或 `.env` 比 API/worker 新，且 monitor 确认无运行任务时，向本项目旧 API/worker 发 `TERM` 后重启。前端只按归属和命令复用，不独立检查源码新旧；不强制杀进程、不安装依赖、不迁移数据库。 |
| `deploy.sh`、`deploy-server.sh` | 从干净的 `main` 工作树部署与 `origin/main` 相同的提交；需要环境变量 `AI_DISTILL_DEPLOY_HOST`、`AI_DISTILL_DEPLOY_USER`、`AI_DISTILL_DEPLOY_DIR`、SSH 和生产操作授权。每次将本机 `.env` 经 SSH 传到服务器并替换服务器 `.env`（保留回滚副本）；SSH 用户必须是 root，服务器需 Docker Swarm。脚本会构建镜像、更新 API/worker 服务及调整存储目录权限；部署前检查 worker 空闲，不运行数据库迁移。成功后会显示本地访问用 SSH 隧道命令。 |

从仓库任意路径运行：`bash scripts/runtime/start.sh`。`start-iterm.sh` 可能在无运行任务时重启本项目 API/worker。部署示例：`AI_DISTILL_DEPLOY_HOST=<host> AI_DISTILL_DEPLOY_USER=root AI_DISTILL_DEPLOY_DIR=<absolute-path> ./scripts/runtime/deploy.sh`。部署会替换远端 `.env` 并更新服务，不能把它当作只传源码的操作；部署前核对本机配置确实应成为服务器配置，并按根 README 和仓库授权边界操作。
