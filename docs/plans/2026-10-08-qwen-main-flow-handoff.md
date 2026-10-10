<!-- 文件职责：记录 2026 10 08 qwen main flow handoff 对应的目标、约束与实施计划；计划状态以正文为准。 -->
# Qwen 主流程接线说明

适用范围：第五步 Qwen 接线。依据：[独立接入计划](2026-10-08-qwen-independent-integration.md)。

## 当前交付

- `server/answer-models/qwen.ts` 提供配置解析、纯文字作答、完成检查、超时取消及安全错误。
- 第五步设置、单条/批量 API、worker、答案保存下载及 F47/F49 校验已接线，详细生产者契约见 [输入与评分契约](2026-10-08-answer-input-and-score-contract.md)。第四步及第六步执行器仍未接通。
- 真实 API 是否通过，以 `docs/evidence/qwen-api-smoke-results.json` 为准；`unverified` 或 `failed` 不能解释成已接通。

## 接口契约

| 接口/数据 | 契约 |
| --- | --- |
| `resolveQwenConfig(raw, env?)` | 返回无凭证 QwenConfig。显式配置优先；直连缺省从 QWEN_MODEL/QWEN_BASE_URL 解析。只有 OPEN_ROUTER_KEY 时默认 OpenRouter 及 qwen/qwen-plus |
| `QwenConfig` | provider 固定 qwen；base_url、model 必填；enable_thinking、max_tokens 可选。只接受这些字段，显式 false 保留，null 无效 |
| `createQwenClient(env?, request?)` | 原生 fetch 调用客户端；第二个参数用于受控请求测试；每次作答重新读取服务端凭证 |
| `client.answer(input)` | config、question、materials；可选 timeout_ms、signal。materials 只接受 name/text；一题一次全新请求，无历史会话 |
| `QwenAnswer` | text 是未裁剪的最终答案；requested_model、提供商实际 model、completion_id、request_id、原始 usage、started_at、finished_at、duration_ms。提供商未返回的元数据为 null |
| `QwenError` | kind、retryable、http_status、白名单 provider_code 和 UUID request_id；不含提供商消息、私密输入、密钥或原始异常 cause |

本模块只验证输入结构，不能判断 question/text 内是否混入标答或私密内容。不要把整个工作流对象或任意文件目录传入。当前不返回思维链，不保存完整 HTTP 响应，也不执行工具或生成实际文件。

OpenRouter 路径只接受 qwen/ 模型 ID；使用 OPEN_ROUTER_KEY，不能传管理密钥。enable_thinking 映射为 reasoning.enabled，并要求路由支持这些参数。直连使用 QWEN_API_KEY/DASHSCOPE_API_KEY；密钥不跨端点混用，不在失败后切换计费路径。

## 接线要求（已完成第五步代码）

1. **项目设置**：沿用 project_step_configs 保存第五步 QwenConfig。调用 resolveQwenConfig 校验；不把 API Key 放入数据库、前端或任务快照。validateStepConfig 已接受第五步并复用 Qwen 配置校验。
2. **入队快照**：将解析后的完整 config 固定到新尝试；记录材料 input_revision 和题目产物版本。执行时使用快照 config，不重新从项目默认值切换模型。
3. **输入选择**：仅从同版本有效题面与成功脱敏材料构建 question/materials。禁止包含 rubric、标答、目标分数、原件路径、映射或缓存；文字附件名称使用允许公开的名称。题目若要求图片、文件交付或工具执行，当前客户端不足，保持明确阻断。
4. **调用及保存**：传入本尝试的取消信号；将完整 text 写入业务产物，保存实际模型、原始 usage、请求标识和时间。不要在普通日志打印答案或请求材料。duration_ms 只表示一次请求耗时，不等同于实际工具执行时长或规则要求的工作时间。
5. **发布与隔离**：发布前在事务中复查项目/工作流未删除、尝试仍有效、材料版本与题目版本未变化。文件保存成功后发布结果；迟到结果只留历史，不能成为当前成功结果。
6. **失败处理**：客户端只调用一次。认证和 quota 保存阻断原因，等待条件恢复；配置和无效响应不得发布成功；rate_limit/network/timeout 及可重试 provider 错误保存分类和可重试标记，当前须显式重新入队，不自动重试。主动取消不自动重试。

## 验收边界

配置保存、并发入队去重、注入提供商的答案落盘入库/下载、题目变化后的迟到隔离及评分版本校验已在隔离 PostgreSQL schema 验证；不是一次真实 Qwen 作答。结果见 docs/evidence/answer-flow-results.json。当前管理密钥阻断真实推理，第四步真实生产者未接通，因此完整闭环尚未验收。
