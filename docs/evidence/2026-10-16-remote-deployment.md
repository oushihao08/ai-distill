# 远程部署与入库验收

日期：2026-10-16。目标服务器 47.110.240.111，目录 `/opt/ai-distill`；仅操作 ai-distill 服务。

## 发布内容

使用与 origin/main 相同的已提交快照 `0335d723da3a62936ddda772c72c0dfbb52d9886`，另加本次 Docker 构建修复与 039 迁移。未发布本机其他未提交变动，未提交或推送工作区。最终镜像 `ai-distill:0335d723da3a-remote039`；构建上下文保留在服务器 `releases/0335d723da3a/`。

构建阶段新增 Node 22，并以 hoisted 布局按锁文件安装依赖；前端类型检查和 Vite 构建通过。容器由 Docker env_file 注入配置，服务及健康检查禁用 Bun 自动 dotenv 加载。项目资料同时挂载 `/app/projects` 和历史数据库绝对路径。现有业务数据与服务器配置保留；服务规格及配置备份位于服务器 `backups/`，不含于本报告。

## 数据库

读取迁移登记发现 001—038 已登记；进一步核对实际远程操作表，发现早期 034 缺少 `redaction_config_digest` 和 `claim_token`。只执行并登记 `039_remote_operation_compatibility.sql`，事务内新增这两个可空字段；未运行全量迁移或修改既有业务记录。

## 实际验收

- SSH 公钥登录和 13700 → 服务器 37900 隧道可用。
- API 健康检查返回 database=connected、schema=ready；专用 server worker 已启动。
- 远程作答状态路由：无令牌 401，正确令牌且不存在的请求 404，证明路由及认证已启用；不代表真实模型作答通过。
- 隔离项目：远程部署验收-20261016，项目 ID `cd64c719-d6b0-406b-8b8d-95f62f093bd9`。
- 工作流 ID `45ddf901-485a-4906-aed8-7fda491312b8`；固定 request key `4aac75c6-b5c0-46d2-be1b-73ae509a26bb`；远程操作 ID `2d65ca5f-b64c-4718-81db-af0acbc7ee50`。
- 本机 remote material run（intake 模式）提交，服务器入库成功，CLI 下载材料 ID `4c3e4102-529e-4e97-a717-bccc966550e0`，退出码 0。使用无个人信息的 TXT，不重做既有题目。
- 两项目来源资料同步完成，rsync 缺失文件检查无待传文件；没有删除远程已有文件或覆盖同名已有文件。

## 未验收范围

未调用真实模型，未验收 PDF 提取、API 脱敏、真实作答、出题或评分；入库完成不表示可以跳过脱敏直接出题。server worker 不处理本机归属或 Agent 任务。未来发布前仍须检查并提交所需代码；当前工作区有其他未提交修改，普通发布脚本的干净工作区要求仍生效。

## 第五期真实材料实验（后续执行）

题目 2（工作流 `5503b039-f3c1-4cca-9de9-146a6f575231`）真实脱敏首次失败，attempt `acf5abc9-5a2d-401c-8999-13f0950bed6f`。OpenRouter 密钥检查 HTTP 200；CoreWeave 返回 403，错误码 unsupported_country_region_territory。同模型 DeepInfra 探测限流；OpenInference 的严格 JSON Schema 合成探测返回 200。

经用户要求解决问题，将第五期 ordinal 9 的 api.provider_options.only 从 coreweave 改为 open-inference，保留 allow_fallbacks=false；模型、提示词和推理开关未改。配置通过既有项目步骤 API 保存，沿用项目级失效规则；旧配置备份在本机 /tmp/ai-distill-q2-redaction-config-before.json（权限 600）。

新 attempt `8e797a2c-6d2d-4d5c-a027-c4998ed123d8` 于 2026-10-16 12:16:30（北京时间）完成，1,076 字段全部通过校验，耗时约 642 秒，21 次请求、12 次重试；不能宣称供应商速度稳定。当前脱敏全文读取成功，26,087 字符。后续本机作者 attempt `ab065ba8-a795-4cd9-a44e-6eef6ba04f5f` 已派发，结果待确认；尚无服务器真实作答成功证据。

后续作者 attempt `ab065ba8-a795-4cd9-a44e-6eef6ba04f5f` 成功（北京时间 12:23:25）。服务器作答使用项目既有 `qwen/qwen3.8-max-0902`：第一次 attempt `7aac4673-9654-4881-863e-729a05076bf7` 在约 304 秒后以 HTTP 200 / invalid_json 失败；启用普通 OpenRouter 文字 SSE 传输后，第二次 attempt `5f69c770-e171-45d9-a514-162b2fa8e740` 在约 304 秒后以 incomplete_finish_reason 失败。因此流式调整没有解决该上游的约五分钟中断问题，不能声明服务器真实作答闭环成功。

传输改动回归：本机 142 项、部署派生镜像 140 项，0 失败；最终服务镜像 `ai-distill:0335d723da3a-stream1`。OpenRouter 当前模型端点仅有 Alibaba（alibaba 与 alibaba/us-east-1），没有其他公司供应商。检查本机仅确认 QWEN_API_KEY 与 DASHSCOPE_API_KEY 均未配置，未读取或输出密钥值。后续更换模型或改用阿里直连需要用户决定；当前作答配置未改。

## 按本地配置对齐网络

用户要求“本地怎么样，服务器就怎么样”。比较两端仅输出是否存在及相等性：OpenRouter 凭证相同，直连 Qwen 凭证均未配置；本地有 HTTP/HTTPS/ALL_PROXY，服务器没有。通过 SSH 反向转发把服务器回环 17890 接到本机代理 7897，服务器经该出口调用 CoreWeave 返回 HTTP 200。代理变量保存到服务器 .env；不会把本机回环端口误当成服务器自己的代理服务。

撤回本轮尝试的普通文字自动流式改动，恢复原客户端、原单测和说明，服务回到镜像 ai-distill:0335d723da3a-remote039 并添加代理变量。第五期仍使用共享数据库现有模型配置；不再更换作答模型或降低校验。新的远程作答 attempt 为 ad36e911-ac4c-48d3-b504-28cb55906014，超过此前约 304 秒中断点仍运行，最终结果待确认。

该网络出口依赖本机代理与 SSH 反向隧道在线；本机关闭或隧道断开时服务器无法使用此代理。重建命令：ssh -N ai-distill-server-proxy；它与本机访问服务器 API 的正向隧道是两个独立连接。服务器独立运行仍需要可用的独立代理出口配置。


## 2026-10-17 本地源码同步与服务器真实作答

本轮用户明确要求同步本地代码，并选择一道可作答题进行服务器真实作答验证。

- 发布的是本地工作区文件快照，基础提交 `5ed494c1ce90f505e99327869c77d07e3a875e7b`，镜像 `ai-distill:8a3aec105bc2`；没有提交或推送 Git，没有覆盖本地未提交修改。快照不是 GitHub main 发布。排除原始材料、运行数据及密钥；没有整体同步项目材料或 skill。
- 发布源码保存在服务器 `/opt/ai-distill/releases/local-8a3aec105bc2/`。本地清单和验收记录位于 `.storage/deploy-runs/20261017-server-answer/`。
- 服务器使用现有配置，只补充当前 SiliconFlow 所需服务端凭证，排除代理变量；不借用本机代理。保留原配置及服务规格备份，未执行数据库迁移，未重启本机服务。
- 常规 deploy.sh 要求干净且与远程 main 一致，因此本轮没有运行该本地入口。服务器部署采用已有 deploy-server.sh 的独立执行副本 `releases/deploy-cached-8a3aec105bc2.sh`：Docker Hub 拉取超时时使用已经缓存的相同版本基础镜像；容器心跳命令增加 `--no-env-file`。空闲检查、健康检查和回滚逻辑保留，等待检查通过后才更新服务。仓库中的部署脚本未修改，后续常规发布仍需处理其心跳命令兼容性。
- 服务器 API、worker 均为单副本，worker 配置 `WORKER_MODE=server`、`MATERIAL_EXECUTION_TARGET=server`；不运行 Agent 出题或评分。构建中的前端类型检查和 Vite 构建通过；未运行后端单元测试。
- 服务器运行镜像的作答队列、派发、API 客户端、配置、远程路由、worker 共六个关键文件 SHA-256 与本次源码清单一致。最终 API health 返回 database=connected、schema=ready，两服务 healthy。

### 一题作答结果

使用内部验收题 `Skill加压验收-20261017-运输-L2-LS02`，工作流 `62dcb64a-8b64-42b9-8e50-0d920c9b304c`。仅重做其作答，历史尝试保留；未操作其他题目或重新生成题面。

- 由本机远程 CLI 经 13700 → 服务器 37900 的正向 SSH 隧道提交。
- 固定请求标识 `b682418b-d549-4daf-afc1-8237502a9a1c`；服务器作答 attempt `ed4cc1f5-f903-43ab-8f59-71c553503529`，终态 succeeded。
- 项目既有模型 SiliconFlow · `Qwen/Qwen3.8-27B`，没有改变项目模型、评分规则或阈值。
- 北京时间 2026-10-17 08:22:01 至 08:33:57，耗时 715.837 秒，答案 25,112 字符；usage 为 prompt 9,460、completion 34,224、total 43,684，其中 reasoning 17,414。
- 答案产物 `36bbb871-7ca4-40da-880e-626dee25216d`。服务器 answer.txt、API 返回答案和本机下载内容 SHA-256 一致：`4636608b286f9b0674a45932366f64deba44551e17744f87a0b01d4c432165c4`。
- 本机核验副本 `.storage/deploy-runs/20261017-server-answer/服务器作答.txt`，结果摘要 `result-summary.json`。敏感业务正文不写入本证据文档。

本轮证明该题在当前供应商和配置下完成服务器 API 作答、持久化及本机取回；不代表所有项目或供应商均通过，不代表答案专业正确或脱敏质量合格。未执行评分、达标派发或归档，也没有运行 Agent。服务器运行不依赖本机代理；本机 SSH 隧道只用于访问和提交任务。
