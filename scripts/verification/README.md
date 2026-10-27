<!-- 文件职责：按当前实现索引系统验证工具，并标明隔离范围、真实外部调用和历史入口。 -->
# 跨项目验证工具

本目录包含源码级验证工具，不是统一测试命令。`verify-*` 名称不代表只读或自动隔离。先看下表和脚本头注释；不得批量执行。所有数据库/模型/真实材料操作仍须遵守根 `AGENTS.md` 的授权边界。

| 脚本 | 当前用途和边界 |
| --- | --- |
| `verify-worker-transactions.ts` | 显式本机端口、固定专用`worker_verify`数据库与随机schema，复用生产材料任务函数及真实任务表约束；验证取消/提交锁竞争、失租、回滚、JSONB原因、提交后回执异常。只用合成数据，退出删schema；不读取业务连接配置、不跑全量迁移或模型，须显式指定证据输出路径。 |
| `verify-answer-flow.ts` | 随机临时 schema 与合成输入；默认用注入执行器，不调用模型；`--real-score` 会调用真实 Codex 评分。写入其声明的结果文件。 |
| `verify-authoring-flow.ts` | 随机临时 schema 与合成输入，但会调用真实 Codex 出题；写入结果文件。 |
| `verify-codex-client.ts` | 启动本机 Codex CLI 并发起一次真实请求；使用合成文本。 |
| `verify-codex-isolation.ts` | 启动本机 Codex CLI sandbox 子进程，检查文件权限；不调用模型，但会读取本机 Codex CLI 可执行文件和写入验证结果。 |
| `verify-domestic-models.ts` | 默认只检查供应商配置；传 `--call <provider>` 会发送一次真实供应商请求并写结果。 |
| `verify-generated-cleanup.ts` | 随机临时 schema 与临时文件，检查工作流生成物清理；不调用模型。 |
| `verify-independent-modules.ts` | 已停用：只输出退役提示并以非零状态退出，不连接数据库。原入口直接写业务schema且使用过时步骤；改用随机临时schema的`verify-project-material-usage.ts`。 |
| `verify-independent-score.ts` | 使用合成题目和匿名答案，调用真实 Codex 独立评分；写入验证结果。 |
| `verify-input-versions.ts` | 随机临时 schema、合成 PDF 文本与注入提取器；不调用 OCR/模型。 |
| `verify-integration.ts` | 已停用：旧Vision配置快照与函数式提取器接口失效，只输出退役提示并非零退出，不读配置/材料、不连接数据库、不调用模型或写文件。MinerU适配器使用`server/materials/pdf-extraction/`定向单元测试；材料来源/使用账/交付隔离链路见`verify-project-material-usage.ts`，两者都不替代真实OCR/脱敏质量验收。 |
| `verify-ocr-page.ts` | 读取脚本中指定的真实 PDF 页，调用配置的 OCR 和实体检查服务；`VERIFY_PAGE` 选择页码。 |
| `verify-project-folders.ts` | 随机临时 schema 与合成目录，检查目录发现/接收/逻辑删除；不调用模型。 |
| `verify-project-material-usage.ts` | 默认显式传`--local-port <端口> --out <证据JSON>`（用户确认连接后的stdin模式见下文），固定127.0.0.1、postgres用户、material_gate_verify专用库（拒绝已有业务schema），不读取业务连接配置；随机临时 schema 与合成数据，覆盖期次隔离、材料永久使用记录、导入和脱敏/原文题目全链路；材料Agent经正式HTTP派发和生产发布函数，注入合成计划；作者、作答和评分执行器均注入合成结果，不调用真实模型。脚本固定legacy消费随机schema，不继承本机local队列；可设`VERIFY_EVIDENCE_DIR`保留实际DOCX/XLSX，目标目录不能已有同名文件。 |
| `verify-project-skill-queue.ts` | **历史脚本**：依赖已撤除的项目 Skill 生成队列/规则注册 API；源码头注明不要执行。 |
| `verify-qwen.ts` | 若本机供应商配置齐全，会发送一次真实 Qwen 请求；使用合成文字，不访问数据库。 |
| `verify-resource-monitor.ts` | 读取当前本机资源并写采样结果；不启动 worker。 |
| `verify-rule-loading.ts` | **已失效的历史脚本**：调用当前不存在的规则注册/发布及独立加载路由；`server/routes.test.ts` 明确验证旧加载路由返回 404。不要执行或按其描述操作。 |
| `verify-rule-versions.ts` | **历史脚本**：依赖已撤除的规则版本注册/冻结流程；源码头注明不要执行。 |

部分脚本将运行结果写到 `docs/evidence/`；它只是脚本输出路径，不是当前规范或当前能力的权威来源。本任务不扫描或修改 `docs/`。临时 schema 隔离的是脚本中被改写的 SQL，并不表示其不会读取真实输入、调用外部模型或写其他路径；具体边界以源码为准。

`verify-local-queue.ts`：`bun --no-env-file scripts/verification/verify-local-queue.ts --port <本机临时PG端口> --out <证据JSON>`；只接受127.0.0.1、queue_verify专用空库，顺序应用真实迁移并在finally删除schema，使用两份临时SQLite和两个PG执行身份验证归属、HTTP取消/认领、TXT入库提取及结果对账。不读取.env、不调用模型、不操作业务库，不能替代实体双机和真实模型验收。

`verify-runtime-consistency.ts`仅接受本机显式端口的`queue_verify`空库，应用全部真实迁移，以双SQLite/PG身份和合成建议执行器核对手动建议、作者冻结复用、达标批量跳过和本机状态投影；不调用真实模型。运行参数`--port <端口> --out <证据JSON>`，可选`--serve`在13700/13701启动隔离API供浏览器验收；收到TERM/INT后停止API、删除schema和临时文件。仅在空专用库运行，不接业务.env。

`verify-project-material-usage.ts`在用户明确提供并确认数据库连接后，可用`--connection-stdin --out <证据JSON>`代替本机专用库参数。完整连接只从无回显stdin读取，不写环境文件或命令参数；验证TLS证书及channel binding。此模式允许数据库已有业务schema，但全部业务SQL重写到随机`verify_project_phases_*`，最终只清理本轮schema与临时目录，不改原ai_distill对象。脚本不执行server/migrate.ts。`--serve-port <本机端口>`在合成流程归档完成后临时提供隔离API，证据旁的`.session.json`保存PID/端口及合成ID；浏览器关闭后向该已核实PID发送SIGUSR1继续防重检查与清理。最终JSON才是完成回执，session文件不是成功证明。模型全部注入；不能将通过解释为真实模型质量或生产部署验收。
