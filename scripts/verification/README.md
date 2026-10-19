<!-- 文件职责：按当前实现索引系统验证工具，并标明隔离范围、真实外部调用和历史入口。 -->
# 跨项目验证工具

本目录包含源码级验证工具，不是统一测试命令。`verify-*` 名称不代表只读或自动隔离。先看下表和脚本头注释；不得批量执行。所有数据库/模型/真实材料操作仍须遵守根 `AGENTS.md` 的授权边界。

| 脚本 | 当前用途和边界 |
| --- | --- |
| `verify-answer-flow.ts` | 随机临时 schema 与合成输入；默认用注入执行器，不调用模型；`--real-score` 会调用真实 Codex 评分。写入其声明的结果文件。 |
| `verify-authoring-flow.ts` | 随机临时 schema 与合成输入，但会调用真实 Codex 出题；写入结果文件。 |
| `verify-codex-client.ts` | 启动本机 Codex CLI 并发起一次真实请求；使用合成文本。 |
| `verify-codex-isolation.ts` | 启动本机 Codex CLI sandbox 子进程，检查文件权限；不调用模型，但会读取本机 Codex CLI 可执行文件和写入验证结果。 |
| `verify-domestic-models.ts` | 默认只检查供应商配置；传 `--call <provider>` 会发送一次真实供应商请求并写结果。 |
| `verify-generated-cleanup.ts` | 随机临时 schema 与临时文件，检查工作流生成物清理；不调用模型。 |
| `verify-independent-modules.ts` | 使用合成数据，但**直接写入 `createPool()` 配置所连的 `ai_distill` schema，不建临时 schema**；在 `finally` 按随机 ID 删除合成行。清理失败可能遗留数据；仅能在已确认的专用测试库上使用，不是日常安全验证入口。 |
| `verify-independent-score.ts` | 使用合成题目和匿名答案，调用真实 Codex 独立评分；写入验证结果。 |
| `verify-input-versions.ts` | 随机临时 schema、合成 PDF 文本与注入提取器；不调用 OCR/模型。 |
| `verify-integration.ts` | 随机临时 schema，但默认读取 Downloads 中的真实房屋买卖 PDF，并调用配置的真实 OCR/实体检查服务；可用 `VERIFY_PDF_PATH` 指定输入，`VERIFY_FULL_PDF=1` 会处理整份文件；还会写 `.storage/.verification-ocr-cache`。 |
| `verify-ocr-page.ts` | 读取脚本中指定的真实 PDF 页，调用配置的 OCR 和实体检查服务；`VERIFY_PAGE` 选择页码。 |
| `verify-project-folders.ts` | 随机临时 schema 与合成目录，检查目录发现/接收/逻辑删除；不调用模型。 |
| `verify-project-material-usage.ts` | 随机临时 schema 与合成数据，覆盖期次隔离、材料永久使用记录、导入和脱敏/原文题目全链路；作者、作答和评分执行器均注入合成结果，不调用真实模型。 |
| `verify-project-skill-queue.ts` | **历史脚本**：依赖已撤除的项目 Skill 生成队列/规则注册 API；源码头注明不要执行。 |
| `verify-qwen.ts` | 若本机供应商配置齐全，会发送一次真实 Qwen 请求；使用合成文字，不访问数据库。 |
| `verify-resource-monitor.ts` | 读取当前本机资源并写采样结果；不启动 worker。 |
| `verify-rule-loading.ts` | **已失效的历史脚本**：调用当前不存在的规则注册/发布及独立加载路由；`server/routes.test.ts` 明确验证旧加载路由返回 404。不要执行或按其描述操作。 |
| `verify-rule-versions.ts` | **历史脚本**：依赖已撤除的规则版本注册/冻结流程；源码头注明不要执行。 |

部分脚本将运行结果写到 `docs/evidence/`；它只是脚本输出路径，不是当前规范或当前能力的权威来源。本任务不扫描或修改 `docs/`。临时 schema 隔离的是脚本中被改写的 SQL，并不表示其不会读取真实输入、调用外部模型或写其他路径；具体边界以源码为准。
