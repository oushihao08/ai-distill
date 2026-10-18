# 独立大模型 API 调用

与 `server/agent/` 并列。统一管理大模型 API 的配置、端点、凭证选择、文字/JSON 请求、完整响应、用量、安全错误、超时与取消。供模型作答、API 脱敏等业务直接调用；不依赖 Agent 或作答模块，不管理业务队列、文件目录和产物发布。

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 公共入口，导出客户端、配置解析及契约 |
| `types.ts` | 消息、响应格式、结果及安全错误；供应商配置共用 shared 类型 |
| `config.ts` | Qwen、Kimi、DeepSeek、豆包、OpenRouter 的端点、模型与参数校验；服务端密钥和环境默认值 |
| `models.ts` | `/api/llm-api/models` 的模型选项和默认配置，复用已登记系统模型，沿用现有表，不新增目录 |
| `concurrency.ts` | 默认 HTTP 传输共享的本机 SQLite 请求槽位及有界排队 |
| `client.ts` | `complete()` 纯文字调用；`completeJson()` JSON 解析及调用方校验；HTTP、取消、超时、usage 和安全日志 |

## 使用

```ts
import {createModelApiClient,resolveModelApiConfig} from '../llm-api';

const config=resolveModelApiConfig({provider:'deepseek',model:'deepseek-chat'});
const result=await createModelApiClient().complete({
 config,
 messages:[{role:'system',content:'完成本次明确任务。'},{role:'user',content:'本次输入'}],
 timeout_ms:3600000,
 signal,
});
// result.text / result.usage / result.queue_wait_ms / result.provider / result.model / result.completion_id
```

业务层显式提供消息。模型不能自行读取本地文件、聊天记忆或工作区；原始数据需要由调用方在消息中提供。仅使用当前请求的消息，没有隐式会话。`completeJson(request, validate)` 默认发送 `json_object`，消息需包含 JSON 要求；调用方提供结构/业务校验器。需要供应商原生 Schema 时显式传 `response_format:{type:'json_schema',json_schema:{name,strict:true,schema}}`，选择支持此参数的模型/端点；不支持则报错，不降级为无约束文本。OpenRouter 使用 `require_parameters:true` 防止静默丢弃输出或思考参数。脱敏v20使用 JSON Schema约束字段字典的必填编号，并保留调用方字段映射校验；附件与页序由任务输入恢复，不依赖模型复述元数据。

## 配置与凭证

通用默认连接为 OpenRouter 标准端点，默认模型为 `deepseek/deepseek-v4.1-flash`，默认关闭思考模式，复用服务端已有 `OPEN_ROUTER_KEY`。可通过 `LLM_API_PROVIDER`、`LLM_API_MODEL`、可选 `LLM_API_BASE_URL` 覆盖；供应商也可使用已有各自的模型/端点环境默认值。默认值是明确的产品配置，不按密钥猜测供应商。业务步骤的覆盖配置优先，并在入队时冻结。

`GET /api/llm-api/models` 返回默认配置和系统模型选项，复用 `system_answer_models` 中启用模型的完整连接配置。表名保留历史命名，作答与脱敏共用目录。脱敏页面复用已有 `/api/answer-models` 目录接口，只选择模型，不重复填写供应商、API 地址或密钥；完整非敏感配置随任务冻结。该只读接口不调用推理 API，不改动项目作答集合。

Qwen 原生使用 `QWEN_API_KEY` 或 `DASHSCOPE_API_KEY`，Kimi 使用 `KIMI_API_KEY` 或 `MOONSHOT_API_KEY`，DeepSeek 使用 `DEEPSEEK_API_KEY`，豆包使用 `DOUBAO_API_KEY` 或 `ARK_API_KEY`，OpenRouter 使用 `OPEN_ROUTER_KEY`，SiliconFlow 使用 `SILICONFLOW_API_KEY`。SiliconFlow 采用 `https://api.siliconflow.com/v1` OpenAI 兼容端点。作答模型目录的新 API 登记默认选 SiliconFlow；通用 API（含脱敏）默认仍按 `LLM_API_PROVIDER`／现有默认值解析，不因作答默认渠道而切换。密钥只在服务端请求时读取，不进入步骤配置、任务快照、前端或普通日志。端点只允许各供应商声明的 HTTPS 主机/路径，禁止携带凭证、查询参数和重定向。

旧 Qwen 作答配置支持通过 OpenRouter 提供 Qwen；其旧默认解析入口保留兼容。新的通用 API 默认值不使用这种推断；默认选择 DeepSeek V4.1 Flash，可显式覆盖。

## 调用方与边界

- `answer-models/dispatch.ts` 只将已校验题面和允许附件转成消息。旧 Qwen/Domestic 客户端是兼容门面，没有独立 HTTP 实现。
- `materials/redaction.ts` 在 API 模式下直接传入已入库原文；Agent 模式沿用本地隔离目录。两种方式由脱敏业务选择。
- `agent/` 继续提供本地 Codex 任务执行，没有 API 适配器，也不依赖本模块。
- 不自动改供应商/模型、不自动重试收费请求。队列和返修调用账本继续由业务模块管理。
- 只接受完整 `finish_reason=stop` 的非空 assistant 文本，拒绝工具调用、拒答字段和截断结果。usage、实际模型名和 completion ID 仅作可选元数据；格式异常时忽略该字段，不使完整正文失败。拒绝时日志使用安全的 `reason_code`；不记录请求/响应正文及密钥。

当前支持纯文字非流式调用和 SSE 完整收集；SiliconFlow 默认使用 SSE。流式与非流式均保留白名单中的异常结束原因，脱敏可据 length 立即有限缩批，仍拒绝截断正文。长文仍受模型上下文与最大输出长度限制；脱敏批次规划由 `materials/redaction-execution.ts` 与脱敏执行器负责，不属于通用 API 客户端。真实 API、模型输出质量和浏览器操作需另外取得证据。

调用开始日志记录实际超时；JSON 解析失败使用 `invalid_json`，业务校验失败沿用调用方的安全原因码。共用错误分类保留 HTTP 状态和安全原因码，不记录原始供应商说明或响应正文。作答失败时，作答任务将安全 `reason_code` 保存在失败结果中；工作流只读投影仅暴露该码，详情页显示对应的响应校验原因。历史失败没有原始响应或原因码的，仍无法追溯具体字段。

## 普通调用与项目钩子的本机并发

`concurrency.ts` 复用现有 SQLite 槽位实现，在存储根目录独立 `.model-api-slots/` 命名空间约束默认 HTTP 传输，限制来自现有 llmApi 设置。普通文字／JSON 调用和钩子复核请求共用上限；不占 Agent 槽位，避免同步钩子嵌套获取同一槽位死锁。`queue_timeout_ms` 限定等待槽位的时间，`queue_wait_ms` 返回实际排队耗时；等待可取消且计入请求总时限。注入 HTTP 替身的单元测试不访问生产槽位。此上限协调同一本机存储的进程，不宣称跨机器全局并发。

## OpenRouter 上游路由

`ModelApiConfig.provider_options` 可携带 `only` 和 `allow_fallbacks`，只在 OpenRouter 配置接受；客户端向 provider 转发并在需要 Schema／reasoning 参数时声明 `require_parameters`。模型身份和路由分别冻结，显式路由保持。CoreWeave 默认只由脱敏配置针对 `deepseek/deepseek-v4.1-flash` 注入，通用客户端和普通作答不指定默认上游。禁止不可用时静默更换模型或供应商。真实上游以供应商返回元数据核实，配置不等于运行证据。


SiliconFlow 请求默认使用 SSE 流式传输并请求 usage，复用现有完整结束校验；只保存完整正文，不将 reasoning_content 拼入答案。所有供应商 HTTP 请求显式关闭 Bun 自带空闲计时，仍由业务 AbortSignal 总时限和取消控制。Bun 已知连接关闭、空闲超时保留安全原因码；不自动重试收费请求。
