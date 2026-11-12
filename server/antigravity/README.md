<!-- 文件职责：说明 Antigravity CLI (agy) 执行客户端、模型目录映射及隔离边界。 -->
# Antigravity CLI 执行与设置

本目录实现本机 Antigravity CLI（`agy`）适配与模型档位映射。业务执行统一经[独立 Agent 模块](../agent/README.md)及其驱动注册表（`server/agent/driver.ts`）进入，不直接调用 `runAgy()`。

## 文件职责

| 文件 | 说明 |
| --- | --- |
| `client.ts` | Antigravity 本地 CLI 客户端：构造 `stream-json` 输入与 `--json-schema` 参数、以 `AgyStreamSessionState`（`ingestAgyStreamLine`）演进 `init` / `step_update` / `result` 步进状态机（精确识别中途流中断后自动续跑完成的会话与未恢复异常）并提取三级结构化输出；底层子进程流控、临时沙箱与 `O_NOFOLLOW` 结果读取复用 [`../agent/cli-runtime.ts`](../agent/cli-runtime.ts)。 |
| `models.ts` | 本机 Antigravity 模型目录与推理档位映射：提供带 `agy:` 命名空间的模型建议清单，并将 `(model, reasoning_effort)` 解析为 `agy` 实际接受的 `--model` 与 `--effort` 参数。 |
| `client.test.ts` | 使用临时目录中的假 `agy` 子进程验证模型档位映射、流式步进状态机（中途流中断自愈 vs 未恢复失败）、隔离沙箱参数、普通出题文件交付、超时强杀、环境变量脱敏及未完成轮次拦截；不调用真实远端模型。 |

## 数据流与执行模式

1. **模型与推理强度映射（`models.ts`）**
   - 支持显式 `agy:<model>` 前缀（默认首选 `agy:gemini-4-carbon`，同时支持 `agy:gemini-4-argon`、`agy:gemini-3.8-flash`、`agy:claude-sonnet-5-5`、`agy:claude-opus-5-5` 及历史模型标识）或原生模型标识。
   - 对分档模型族（`gemini-4-carbon`、`gemini-4-argon`、`gemini-3.8-flash`、`claude-sonnet-5-5`、`claude-opus-5-5`），按任务冻结的 `reasoning_effort`（`low` / `medium` / `high`）自动解析为对应的 `<family>-<tier>`（例如 `gemini-4-carbon-medium`），并同时向 CLI 传递 `--effort`。
   - `init` 事件返回实际加载模型标识时，写入 `returned_model`。

2. **普通出题（`execution_profile=fresh_authoring`）**
   - 在项目 `working_directory` 下运行：`agy --model <model> --effort <effort> --input-format stream-json --output-format stream-json --dangerously-skip-permissions --print=`。
   - 不启用 `--sandbox` 或 `--disable-slash-commands`，保留工作区 `AGENTS.md`、指定 `SKILL.md`、文件读写、Shell/计算、网络检索及已配置 MCP 工具。
   - 结果从 `output/result.json` 安全读取（校验普通文件、非外部软链、$\le 32\text{ MiB}$），聊天末条回复保存至 `output/completion.txt`。

3. **受限与盲评隔离任务**
   - 复制输入至系统临时目录 `/tmp/ai-distill-agy-*`（脱离宿主仓库 `AGENTS.md` 与 `.agents/`），附加 `--sandbox --disable-slash-commands --dangerously-skip-permissions`（`isolate_context` 任务额外传入 `--settings '{}'`）。
   - 结构化任务传入 `--json-schema <schemaPath>`，提取 `result.structured_output` 落盘至 `output/result.json`；文本任务（如独立评分、盲作答）将 `result.response` 落盘至 `output/result.txt`，并将 `output/` 同步回源目录。

## 维护边界

- 子进程环境仅保留 `HOME`、`PATH`、`LANG`、`TMPDIR`、`USER`、`LOGNAME`、`AGY_HOME` 及代理变量，不透传数据库或供应商 API 密钥。
- 二进制默认优先读取 `AGY_BIN`，否则查找 `~/.local/bin/agy` 或 `PATH` 中的 `agy`。
