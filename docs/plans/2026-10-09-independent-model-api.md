# 独立大模型 API 模块

目标：大模型 API 调用与本地 Codex Agent 并列管理；作答统一使用 API 模块，脱敏由业务选择 API 或 Agent。Agent 不增加 API 后端。

## 当前实现

1. `server/llm-api/` 管理供应商配置/端点/密钥、消息、纯文字和 JSON 输出、完整响应、安全错误、用量、超时、取消和日志。支持 Qwen 原生、Kimi、DeepSeek、豆包、OpenRouter；按用户修正，默认复用 OpenRouter GLM-5.3-Flash，可配置覆盖。
2. 作答保留题面/允许附件的隔离契约和模型集合/队列，所有 HTTP 调用下沉到 API 模块；旧 Qwen/Domestic 入口保留兼容。
3. 脱敏设置支持 `provider:api` 加 `api:{provider,base_url,model,...}`，或现有 `provider:codex` 配置。未设置执行方式时默认 API，默认模型参数复用统一 OpenRouter 配置和 GLM-5.3-Flash，可用 `LLM_API_*` 覆盖。脱敏只从统一模型目录选择模型，不重复填写供应商或 URL。显式保存的 Codex 设置不被自动改写。
4. API 脱敏与作答共用现有 4 路 API worker，Codex 脱敏仍在本地 Agent 执行池。提交前保留原有附件指纹/取消校验；设置更新和恢复默认共用事务失效逻辑并终止旧返修链。返修快照保存所选后端和具体 API 配置；缺失配置冻结为缺失，不在后续轮次悄悄读取新默认值。
5. 沿用现有步骤配置 JSON 和结果字段，不新增数据库迁移。API 脱敏保存 completion_id/usage，并纳入现有 API 费用统计；缺价格或 usage 仍显示未知。

## 实际验证与限制

只做源码/调用关系/SQL 参数/差异核对及 TypeScript/Vue 类型检查；根类型检查与修改前基线比较。遵循 AGENTS.md，不运行测试、lint、开发服务、真实模型调用、远程数据库写入或服务重启。

本次不证明真实 API 可用、50 页全文输出完整、实际脱敏准确性、供应商限额或 1000 份吞吐，也不证明浏览器设置操作通过。长文自动拆分不属于此次共享调用模块的范围。

协议依据：[OpenRouter 结构化输出](https://openrouter.ai/docs/guides/features/structured-outputs)、[Qwen 结构化输出](https://help.aliyun.com/zh/model-studio/qwen-structured-output)。JSON Object 不等于 Schema 或语义校验；各调用方继续承担结果验证。

## 2026-10-09 表单纠正

原实现把供应商、URL 和模型 ID 留给脱敏步骤重复配置，且没有有效默认模型。现由 llm-api 的只读模型接口复用既有系统模型目录；脱敏默认 OpenRouter GLM-5.3-Flash，并保留 Agent 切换。没有创建第二份目录或修改远程数据。推荐依据是 OpenRouter 当日模型目录中的长上下文、输出容量和价格，以及系统已有该模型登记；并非真实脱敏质量验收。
