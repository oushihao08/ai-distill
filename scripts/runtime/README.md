<!-- 文件职责：说明本机服务启动和部署脚本的入口及影响。 -->
# 运行脚本

| 脚本 | 用途与边界 |
| --- | --- |
| `start.sh`、`start.ts` | 从任意目录启动本地 API、worker 和前端；不安装依赖、不迁移数据库、不重启已有服务。 |
| `start-iterm.sh` | macOS iTerm 启动入口；`npm run start:iterm` 调用此文件，按项目保护逻辑复用服务或检查空闲状态后重启本项目过期进程。 |
| `deploy.sh`、`deploy-server.sh` | 将与 GitHub `main` 一致的已提交快照部署到明确指定的服务器；需要环境变量、SSH 和生产操作授权，不执行数据库迁移。 |

从仓库任意路径运行：`bash scripts/runtime/start.sh`。部署前阅读根 README 和仓库授权边界。
