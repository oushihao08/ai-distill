<!-- 文件职责：说明本机服务启动和部署脚本的入口及影响。 -->
# 运行脚本

| 脚本 | 用途与边界 |
| --- | --- |
| `start.sh`、`start.ts` | 从任意目录启动本地 API、worker 和前端；先检查 API/前端端口，已占用时退出，不复用或停止已有进程；不安装依赖、不迁移数据库。 |
| `run-scoped-batch.ts` | 已授权临时批次入口：`bun scripts/runtime/run-scoped-batch.ts --state <状态JSON> --tick <推进脚本>`；读取固定workflow_ids，拥有一个限定worker和私有stdin。执行结束/异常时关闭管道、等待在途结算后退出；不接管旧PID、不发送强制终止、不自动重试。状态已终态则不启动worker；遗留锁或未确认旧worker拒绝接管。 |
| `start-iterm.sh` | macOS iTerm启动入口；只复用匹配进程。源码/配置比API或worker新时拒绝自动替换，提示按原参数安全停止后再启动，避免丢失进程环境覆盖及空闲检查竞争；不发送停止信号、不安装或迁移。 |
| `deploy.sh`、`deploy-server.sh` | 从干净的 `main` 工作树部署与 `origin/main` 相同的提交；需要环境变量 `AI_DISTILL_DEPLOY_HOST`、`AI_DISTILL_DEPLOY_USER`、`AI_DISTILL_DEPLOY_DIR`、SSH 和生产操作授权。每次将本机 `.env` 经 SSH 传到服务器并替换服务器 `.env`（保留回滚副本）；SSH 用户必须是 root，服务器需 Docker Swarm。脚本会构建镜像、更新 API/worker 服务及调整存储目录权限；部署前检查 worker 空闲，不运行数据库迁移。成功后会显示本地访问用 SSH 隧道命令。 |
| `docx-to-image-pdf.py` | 批量将 DOCX 先经隔离的 LibreOffice 和 macOS 中文字体环境转成 PDF，再逐页栅格化为无可提取文本的 PDF。macOS 即使外部设置了 `FONTCONFIG_FILE` 也使用本次隔离配置；DOCX 含中文但中间 PDF 未嵌入可用中文字体时拒绝发布，已知错误回退字体同样拒绝。缓存文件名含字体校验版本，避免复用旧输出。可传多个本机 DOCX，或重复 `--workflow <UUID>` 调用共用纯文本材料 DOCX 导出；`--workflow <UUID> --include-images` 改为下载冻结图文 DOCX，单题可附 `--preview-preparation-id <UUID>` 预览同来源新整理结果，不改旧题快照。依赖本机 soffice、pdffonts、pdftotext、pdfunite 与 Python pypdfium2/Pillow；默认使用本机 3700 和 `assets/out`，可显式指定 `--api-url`、`--asset-root`、`--soffice`。输出文件名含源路径摘要，结果写入 `results.json`；不覆盖已有 PDF、不改原件、不上传。图像 PDF 仍可由 OCR 识别，不能当作保密措施。 |

从仓库任意路径运行：`bash scripts/runtime/start.sh`。`start-iterm.sh` 不自动重启存活的过期API/worker。部署示例：`AI_DISTILL_DEPLOY_HOST=<host> AI_DISTILL_DEPLOY_USER=root AI_DISTILL_DEPLOY_DIR=<absolute-path> ./scripts/runtime/deploy.sh`。部署会替换远端 `.env` 并更新服务，不能把它当作只传源码的操作；部署前核对本机配置确实应成为服务器配置，并按根 README 和仓库授权边界操作。

- `ofd/`：经显式授权安装OFDRW本地运行依赖，提供OFD整页转PDF桥接；不随服务启动自动安装。详见[OFD工具](ofd/README.md)。

`apply-local-queue-migration.ts`是047定向迁移工具：`bun scripts/runtime/apply-local-queue-migration.ts`默认只列全部未登记迁移与在途计数；显式`--apply`只应用047，拒绝其他必要迁移未齐；允许未归属在途任务继续，DDL仅等待短事务锁且超时回滚。不调用全量迁移器、不启动服务、不转移旧队列。旧消费者可以收尾未归属任务，但不会领取已归属任务；全部旧队列退役仍须逐机核对。队列启用与恢复见`server/execution-queue/README.md`。

`apply-authoring-defaults-migration.ts`默认只读列出待迁移清单；显式`--apply`仅应用048，其他必要迁移未齐时拒绝执行。需要单独数据库迁移授权，不重启服务或修改业务期次。

`apply-active-phase-number-migration.ts`默认只读列出待迁移清单；显式`--apply`仅应用052，可保留独立的051待迁移而不会顺带应用。其他未登记迁移会令它拒绝执行。该迁移允许已删除期次的期号被重新创建，保留旧期次历史行；不重启服务、不改业务期次。

`apply-atomic-import-constraint-migration.ts`默认只读核对待迁移清单；显式`--apply`仅应用059，存在任何其他未登记迁移时整笔拒绝。该迁移仅让原子导入版本使用提取任务成功门禁代替旧intake校验，不回写历史任务，也不启动或重启服务。

`apply-material-preparation-migrations.ts`默认只读列出待迁移文件；显式`--apply`仅应用051和053，若存在其他未登记迁移则整笔拒绝。使用2秒锁等待和30秒语句超时；仅增加可选材料整理结果及题目方向/场景使用表，不回填业务记录、不重启服务。运行前须确认目标数据库和在途任务影响。

`start-iterm.test.ts`仅提取过期拒绝分支，用假PID检查退出；不会运行完整启动器或发送进程信号。
