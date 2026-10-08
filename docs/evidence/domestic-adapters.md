# 国产作答模型独立模块验收

2026-10-08；第四阶段②。仅新增 `server/answer-models/domestic.ts`、`domestic.test.ts` 和本说明，未接公共路由、队列或数据库。现有 Qwen 实现与共用 provider 契约保持原样。

## 接口和配置

`resolveDomesticConfig(raw, env?)` 返回 `DomesticConfig`；`createDomesticClient(env?, request?)` 返回 `AnswerClient<DomesticConfig>`。调用 `answer({config,question,materials:[{name,text}],timeout_ms?,signal?})`，输出沿用 `AnswerResult`。

配置只允许 `provider`（必填）、`base_url`、`model`、可选正整数 `max_tokens`。模型必须由显式配置或对应 `*_MODEL` 提供，没有默认模型；配置中不含凭证。`base_url` 未指定时使用下表官方默认，不根据密钥推测地域。

| provider | 默认 base_url | 服务端凭证（前者优先） | 配置环境变量 |
| --- | --- | --- | --- |
| kimi | https://api.moonshot.ai/v1 | KIMI_API_KEY / MOONSHOT_API_KEY | KIMI_BASE_URL、KIMI_MODEL |
| deepseek | https://api.deepseek.com | DEEPSEEK_API_KEY | DEEPSEEK_BASE_URL、DEEPSEEK_MODEL |
| doubao | https://ark.cn-beijing.volces.com/api/v3 | DOUBAO_API_KEY / ARK_API_KEY | DOUBAO_BASE_URL、DOUBAO_MODEL |

Kimi 同时允许显式配置中国端点 `https://api.moonshot.cn/v1`，需配置该平台可用的凭证；DeepSeek 同时允许 `/v1`。豆包仅支持已核对的北京 Chat API，`model` 可以是模型 ID 或推理接入点 ID。其他域名、明文 HTTP、端口、URL 凭证、查询、hash、错误路径和 OpenRouter 均拒绝；禁止重定向和跨供应商自动 fallback。一个供应商的密钥不用于另一个供应商。

仅请求非流式纯文字、单条独立 user 消息，内容 JSON 只有题目和附件。未实现图片、文件、工具、历史会话及自定义参数透传。显式 `thinking` / `enable_thinking` / `reasoning_effort` 配置会被拒绝，不猜测模型兼容性；未指定模式时遵循供应商该模型默认。适配器只返回最终 `content`，不把 `reasoning_content` 当作答案。调用方仍负责确保文字自身不含 rubric、标答或私密映射。

## 返回及错误

完整答案文本与原始 usage 对象保留；实际模型、completion ID、request ID 或 usage 缺省时为 null，不伪造。必须单个 assistant 结果且 finish_reason=stop；截断、工具调用、拒绝、空答案与格式错误均不接受为成功。时间戳和耗时按本次调用记录。

`DomesticError` 包含 kind/retryable/http_status/provider_code/request_id，消息固定，不保留原始错误 body、message、异常 cause。HTTP 401/403 为认证，402 为额度，429 为速率，408 为超时，400/404/422 为配置，其他为供应商错误；只对网络、超时、速率及服务端错误给出 retryable，不自行重试。供应商细分错误码未映射，provider_code 保持 null；非 UUID request ID 保持 null。仅凭上述 HTTP 分类不能进一步证明具体余额或模型权限根因。

默认 120 秒总超时覆盖 fetch 与响应 body；主动取消和超时会 abort，finally 清理计时器与取消监听。

## 验证证据

- TDD 首轮占位实现：57 项失败，确认主要行为尚未实现；实现后 120 项通过。补充覆盖元数据、真实 fetch 响应体、网络异常等边界后 135 项通过。
- 显式 null 超时回归先失败（被错误默认化），修正后 **136 项通过、0 项失败**。
- `bun test server/answer-models/domestic.test.ts`：136 通过，232 次断言。包含三个供应商的请求/密钥隔离、字段白名单、完整文本/usage、HTTP 安全失败、取消清理、响应体超时，以及只在本机测试夹具上的原生 fetch 未完成响应体超时。
- 独立类型检查通过：`./node_modules/.bin/tsc --noEmit --strict --skipLibCheck --target ESNext --module ESNext --moduleResolution Bundler --types bun --lib ESNext,DOM,DOM.Iterable server/answer-models/domestic.ts server/answer-models/domestic.test.ts`。
- **未真实调用供应商**：当前环境没有上述供应商普通推理凭证；OpenRouter 管理密钥不能替代这些凭证。未做正式测评、队列/数据库保存、浏览器或端到端验收。

## 官方协议核对

2026-10-08 使用官方来源核对端点、Bearer、文字非流式消息、最终答案/usage 和结束原因。模型示例仅为协议说明，不作为项目默认模型或可用性承诺。

- [Kimi 国际 Chat Completions](https://platform.kimi.ai/docs/api/chat)：`api.moonshot.ai/v1/chat/completions`、最终 content、usage、finish_reason。
- [Kimi 中国快速开始](https://platform.kimi.com/docs/get-api-key)：`api.moonshot.cn/v1/chat/completions` 和 MOONSHOT_API_KEY。
- [DeepSeek 首次 API](https://api-docs.deepseek.com/zh-cn/)：官方根端点与独立文字非流式请求。
- [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)：max_tokens、默认模式、响应协议。
- [DeepSeek 官方 WorkBuddy 集成](https://api-docs.deepseek.com/quick_start/agent_integrations/workbuddy/)：显式 `/v1/chat/completions`。
- [火山方舟 Chat API](https://docs.volcengine.com/docs/ark/chat-api?lang=zh&redirect=1)：北京端点、ARK_API_KEY、max_tokens、message.content、finish_reason 和 usage。
