<!-- 文件职责：索引需人工选择和审查的启动、调查及验收脚本，并标注运行影响。 -->
# 人工启动、调查与验收脚本

此目录不属于日常 worker 队列。脚本名称中的 verify／review 不代表只读或已验收；部分会连接真实数据库、调用模型、上传 PDF 和写证据文件。不要批量运行全部脚本。执行前阅读目标脚本，核对当前文件路径、历史任务 ID、输出覆盖和授权。

| 脚本 | 用途／运行影响 |
| --- | --- |
| `start-iterm.sh` | macOS 启动或复用本项目 API、前端、worker；源码晚于 API／worker 进程时，先确认没有运行中任务再正常停止旧进程并重启；任务状态未知或仍在运行时不停止服务；同时识别 `bun file.ts` / `bun run file.ts`，核对项目目录；不迁移数据库，不停止占用端口的其他进程 |
| `deploy.sh`、`deploy-server.sh` | 从与 GitHub `main` 一致的干净提交发布固定 Swarm API/worker；不自动推送；每次经 SSH 加密同步本机 `.env` 到服务器并限制为 640 权限；检查 API 数据库／迁移就绪和 worker 心跳；失败时恢复原 `.env` 并回滚服务或移除本次新建服务；不运行迁移 |
| `read-logs.ts` | 只读筛选本机结构化日志；限制扫描文件数、字节数及结果条数 |
| `verify-project-folders.ts`、`verify-input-versions.ts`、`verify-generated-cleanup.ts` | 临时 PostgreSQL schema 与合成材料；目录接收、版本、重置和清理 |
| `verify-rule-versions.ts`、`verify-rule-loading.ts`、`verify-project-skill-queue.ts` | 旧规则版本绑定流程的历史验收脚本；对应 API 已停用，不适用于当前版本，也不要执行。当前 skill 队列边界由 `server/skill-generation/*.test.ts` 覆盖；历史规则版本结论见 `docs/evidence/2026-10-08-rule-loading.md` |
| `verify-project-skill.ts` | 真实首期规则与真实 Codex 生成候选，不自动采用发布 |
| `verify-codex-isolation.ts` | 本地 CLI 沙箱子进程检查，不等于模型调用验收 |
| `verify-codex-client.ts`、`verify-independent-score.ts` | 合成输入，真实 Codex 冒烟／独立评分 |
| `verify-authoring-flow.ts` | 临时数据库、合成材料，真实 Codex 出题与质检及发布检查 |
| `verify-answer-flow.ts` | 临时数据库及注入作答／评分；`--real-score` 可实际调用评分 |
| `verify-independent-modules.ts` | 合成数据库夹具验证达标、发布、导出和模型设置模块 |
| `verify-qwen.ts` | 单次合成请求，真实供应商调用，保存安全摘要 |
| `verify-domestic-models.ts` | 默认配置检查；`--call` 才对指定供应商发送一次合成请求 |
| `verify-resource-monitor.ts` | 本机资源采样及证据文件写入，非完整 worker 验收 |
| `verify-integration.ts` | 临时数据库，真实材料提取／脱敏；PDF 路径及完整／单页范围取决于环境配置 |
| `verify-real-question-folders.ts` | 指定真实题目业务流程，会改变对应工作流并调用已接入执行器 |
| `verify-ocr-page.ts` | 指定真实 PDF 页的智谱识别与实体检查 |
| `run-flash-max-question-pdfs.ts` | 真实题目页级 Flash max OCR、检查点复用与私有落盘 |
| `try-glm-ocr-sample.ts`、`try-glm-ocr-question-folder.ts` | 将指定真实 PDF 发至 layout_parsing，私有保存结果 |
| `audit-current-ocr.ts`、`review-glm-ocr-quality.ts`、`review-glm-ocr-folder-samples.ts`、`verify-ocr-speed-quality.ts` | 真实源图与候选文本的模型复核，可能调用多次；不是全文人工准确率 |
| `compare-glm-ocr-page-cache.ts` | 对齐历史 GLM-OCR 与缓存，计算文本相似度；不是识别准确率 |

常见输出在 `docs/evidence/`，包含私有原文的中间结果位于 `.storage/` 下。临时 schema 脚本通常在 finally 清理，但中断和网络故障仍需核查残留；不能把临时 schema 解释为没有数据库写入。固定历史 ID、日期或样本路径仅适用于当时调查，不是系统默认配置。

运行限制见根 [AGENTS.md](../AGENTS.md)。文档和注释任务不授权执行上述脚本，命令通过也只证明其注明的范围。

`start.sh` 定位仓库并执行 `start.ts`，后者同时启动 API、worker 和 Vite。退出或 Ctrl+C 会停止本次启动的进程组；不安装依赖、不迁移、不停止已有服务。`read-logs.ts` 的相对 STORAGE_DIR 与服务一致，按仓库根目录解析。

云端发布前显式设置 `AI_DISTILL_DEPLOY_HOST`、`AI_DISTILL_DEPLOY_USER`、`AI_DISTILL_DEPLOY_DIR`。仓库根目录 `.env` 必须含有效 `DATABASE_URL`；每次发布会通过 SSH 加密传输并覆盖服务器 `.env`，失败时恢复上一份配置；部署账号须有 root 权限以设置容器的非 root 存储权限。首次部署会把已有 storage 内容所有者切换为 UID 10001，不改正文；UID 冲突时拒绝部署。已有 worker 心跳缺失、不新鲜或显示仍有运行任务时，部署会停止。迁移由独立人工流程完成，版本不兼容时健康检查会拒绝就绪并回滚。
