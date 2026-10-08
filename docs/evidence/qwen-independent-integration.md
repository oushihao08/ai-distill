# Qwen 独立接入验收记录

日期：2026-10-08（北京时间）。范围：[独立接入计划](../plans/2026-10-08-qwen-independent-integration.md)。

## OpenRouter 补充接入与当前结论

用户补充指定 OPEN_ROUTER_KEY 后，已增加同一 Qwen 客户端的 OpenRouter 路径。官方模型目录实际包含 qwen/qwen-plus，本轮用它作合成材料冒烟，不把这个选择设为正式评测模型要求。接口支持路径见 [OpenRouter API](https://openrouter.ai/docs/api_reference/overview)，思考参数见 [Reasoning](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)。

当前真实模型请求返回 HTTP 401。独立只读 GET /api/v1/key 返回200，is_management_key=true、is_provisioning_key=true，未过期。根因是当前变量中保存的是管理密钥；[官方说明](https://openrouter.ai/docs/guides/overview/auth/management-api-keys)明确管理密钥不能用于 completion。未创建、删除或修改任何账户密钥。需要普通推理密钥完成真实验收。

新增测试覆盖自动解析、模板空值、网关思考参数、usage.cost、密钥端点隔离及402/408/429数字错误。Qwen 针对性测试现为98项；以下87项与全量结果属于首轮快照。

本轮 Qwen 模块、测试及验收脚本的独立 TypeScript 检查通过。上述 PDF 断点类型缺口现已修复；2026-10-08 最新全量后端 429 项测试、整体类型检查和构建通过。真实 Qwen 凭证阻断仍未解决。

## 官方资料核查

核查时间为本次实施；以下为当前协议依据，模型能力与账号可用性仍须实际验证。

| 来源 | 本次采用的事实 |
| --- | --- |
| [OpenAI 兼容接入说明](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope) | POST /chat/completions；Bearer 认证；Key 与端点地域对应；业务空间域名可用，旧 DashScope 域名仍可用 |
| [Chat Completions API](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions) | 非流式纯文字消息；enable_thinking 直接放 HTTP body 顶层且支持范围依模型；完整结果为 finish_reason=stop；length 表示截断；答案与 usage 分开 |
| [错误码](https://help.aliyun.com/zh/model-studio/error-code) | Arrearage 为欠费；Throttling.AllocationQuota/insufficient_quota 为 Token 限流，不能直接解释成账户欠费；401/403 需检查认证及权限 |
| [API Key 配置](https://help.aliyun.com/zh/model-studio/get-api-key) | 凭证放服务端环境；本次未读取或显示任何凭证正文 |

未固定模型支持名单；语法合法不代表模型存在、有权限或支持当前参数。测试模型名属于受控样例，不是账号可用性证据。

## 实现范围

实现位于 `server/answer-models/qwen.ts`。使用现有 Bun fetch，无新增依赖。明确校验配置与文字输入，保留显式 false；拒绝额外评审字段、文件路径和多模态结构。仅向选定阿里云 HTTPS 兼容端点发送请求，拒绝带凭证/查询参数的 URL 和重定向。

保存完整最终答案、实际模型与原始 usage，不伪造缺失数据。错误按配置、认证、额度、限流、网络、超时、取消、提供商与无效响应分类；诊断只保留允许的错误码和 UUID，不输出提供商正文或原始异常 cause。客户端不自行重试。

## 首轮验证结果（OpenRouter 接入前）

- 初始 RED：82 项测试失败，原因是配置及调用尚未实现。
- 补充边界测试发现显式 null 意外回退环境默认值、非 assistant 消息被接受；分别修复并复验。
- `bun test server/answer-models/qwen.test.ts`：87 通过、0 失败。覆盖请求白名单、配置与凭证、原始答案与 usage、错误分类及隐私、超时、取消和监听清理。
- 响应体超时测试使用临时本机 HTTP fixture 与原生 fetch，确认超时覆盖返回头之后的正文读取，并关闭本次连接；不调用模型服务。
- `./node_modules/.bin/tsc --noEmit`：通过，范围为后端、shared 和 scripts。
- 收尾全量 `bun test server`：193 通过、6 失败，共199项。6 项失败均来自已有 `server/codex/client.test.ts` 与占位客户端，涉及登录、执行、超时、取消和独立校验，不属于本次修改范围。不能宣称整个仓库测试通过。

## 首轮真实调用与缺口（历史记录）

运行 `bun scripts/verify-qwen.ts` 可用合成题面和合成文字材料执行一次真实调用，最多等待30秒。已有凭证时会消耗 API 用量；无配置时不发送请求，退出码2，不制造成功记录。退出码0仅证明取得完整有效答案，不证明法律作答质量。

首轮环境未配置 QWEN_API_KEY/DASHSCOPE_API_KEY、QWEN_BASE_URL、QWEN_MODEL，当时真实 API 验收为 **未实测**。最新证据已更新为本轮 OpenRouter 401失败，见 [冒烟记录](qwen-api-smoke-results.json)与本页顶部结论；不保存题面、答案或密钥。

本次实际运行冒烟脚本：退出码2，request_attempted=false、called_provider=false；三项必需配置缺失。已请求用户在本项目 .env 中配置，不要求在聊天里提供密钥。真实调用这一验收项仍待完成。

主流程接线及验收要求见 [接线说明](../plans/2026-10-08-qwen-main-flow-handoff.md)。未修改公共路由、worker、共享类型、迁移、PDF/Codex/样式实现；F42/F43 仍为局部交付，未宣称第五步或八步闭环完成。

## 主流程后续交付（2026-10-08）

第五步配置页面、入队/worker/答案留存下载、F47 输入快照及 F49 程序校验已接线；前述未修改公共文件的边界仅指先前独立模块阶段。新增验证和未确认项见 [作答输入与评分校验验收](answer-input-and-score-validation.md)。真实API仍由管理密钥401阻断，未宣称完整闭环通过。
