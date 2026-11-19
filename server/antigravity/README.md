<!-- 文件职责：说明 Antigravity CLI (agy) 执行客户端、模型目录映射及隔离边界。 -->
# Antigravity CLI 执行与设置

本目录实现本机 Antigravity CLI（`agy`）适配与模型档位映射。业务执行统一经[独立 Agent 模块](../agent/README.md)及其驱动注册表（`server/agent/driver.ts`）进入，不直接调用 `runAgy()`。

## 文件职责

| 文件 | 说明 |
| --- | --- |
| `client.ts` | Antigravity 本地 CLI 客户端：构造 `stream-json` 输入与 `--json-schema` 参数、以 `AgyStreamSessionState`（`ingestAgyStreamLine`）演进 `init` / `step_update` / `result` 步进状态机（精确识别中途流中断后自愈完成与未恢复异常）、遇瞬时断网按原 `conversation_id`（`--conversation`）同目录自动续跑（最多 4 次，遵守总超时预算）、未建会话的冷启动重试、stdout 静默看门狗及超时后已落盘题包回收（见下文第 4–7 条）、过滤无关宿主全局 Skill，并支持 `_part_rubric.json` + 纯文本 `_part_*.txt`（兼容旧 `_part_*.json`）无损拼装三级结构化输出；底层子进程流控、临时沙箱与 `O_NOFOLLOW` 结果读取复用 [`../agent/cli-runtime.ts`](../agent/cli-runtime.ts)。 |
| `models.ts` | 本机 Antigravity 模型目录与推理档位映射：提供带 `agy:` 命名空间的模型建议清单，并将 `(model, reasoning_effort)` 解析为 `agy` 实际接受的 `--model` 与 `--effort` 参数。 |
| `client.test.ts` | 使用临时目录中的假 `agy` 子进程验证模型档位映射、流式步进状态机（中途流中断自愈、瞬时断流 `--conversation` 续跑 vs 未恢复失败）、纯文本与 JSON 分片组装、隔离沙箱全局 Skill 排除清单、普通出题文件交付、超时强杀、环境变量脱敏及未完成轮次拦截；不调用真实远端模型。 |

## 数据流与执行模式

1. **模型与推理强度映射（`models.ts`）**
   - 支持显式 `agy:<model>` 前缀（默认首选 `agy:gemini-4-carbon`，同时支持 `agy:gemini-4-argon`、`agy:gemini-3.8-flash`、`agy:claude-sonnet-5-5`、`agy:claude-opus-5-5` 及历史模型标识）或原生模型标识。
   - 对分档模型族（`gemini-4-carbon`、`gemini-4-argon`、`gemini-3.8-flash`、`claude-sonnet-5-5`、`claude-opus-5-5`），按任务冻结的 `reasoning_effort`（`low` / `medium` / `high`）自动解析为对应的 `<family>-<tier>`（例如 `gemini-4-carbon-medium`），并同时向 CLI 传递 `--effort`。
   - `init` 事件返回实际加载模型标识时，写入 `returned_model`。

2. **普通出题（`execution_profile=fresh_authoring`）**
   - 在项目 `working_directory` 下运行：`agy --model <model> --effort <effort> --input-format stream-json --output-format stream-json --disable-slash-commands --dangerously-skip-permissions --print=`。
   - 不启用 `--sandbox` 或 `--settings '{}'`，完整保留工作区 `AGENTS.md`、任务提示词指定的项目 `SKILL.md`、文件读写、Shell/计算、网络检索及已配置 MCP 工具；通过 `--disable-slash-commands` 与边界指令屏蔽非交互模式下的斜杠命令/无关宿主全局 Skill 扩展。
   - 长文本落盘采用 `_part_rubric.json` + 纯文本 `_part_approach.txt` / `_part_ref_*.txt`（兼容 `_part_question.txt` 及旧 `_part_*.json`），由脚本或 `assembleAgyChunkedOutput()` 无损合并为 `output/result.json`（校验普通文件、非外部软链、$\le 32\text{ MiB}$），聊天末条回复保存至 `output/completion.txt`。

3. **受限与盲评隔离任务（含脱敏、材料整理、独立评分、盲作答）**
   - 复制输入至系统临时目录 `/tmp/ai-distill-agy-*`（脱离宿主仓库 `AGENTS.md` 与 `.agents/`），在临时工作区 `.agents/skills.json` 与 `.agents/plugins.json` 写入全局 `~/.gemini/config/` 与 `~/.agents/skills` 的 `exclude` 清单（不触碰真实用户目录、不随 `output/` 考回），并附加 `--sandbox --disable-slash-commands --dangerously-skip-permissions --settings '{}'`。
   - 结构化任务传入 `--json-schema <schemaPath>`，提取 `result.structured_output` 落盘至 `output/result.json`；文本任务（如独立评分、盲作答）将 `result.response` 落盘至 `output/result.txt`，并将 `output/` 同步回源目录。

4. **瞬时断网同会话续跑**
   - 若会话已建立 `conversation_id`（非模型名无效、未授权、配额耗尽等永久性错误）而遭遇流中断或非零退出，且总预算仍有剩余时，在同一工作区（保留磁盘已有分片/进度文件）使用 `--conversation <conversation_id>` 自动续跑最多 4 次并累加用量。

5. **冷启动重试**
   - 尚未建立 `conversation_id` 即非零退出（如 2026-11-18 实测的启动 30 秒内 `Eligibility check failed ... EOF`），且不属于永久性错误、剩余预算超过 60 秒时，重新冷启动最多 2 次；与续跑分开计数。

6. **静默看门狗**
   - stdout 连续 20 分钟没有任何事件即判定卡死（实测正常单步最长约 1.5 分钟；2026-11-18 有会话在 `search_web`/写文件步骤后静默 90 分钟直到 2 小时总超时）。结束子进程后按第 4、5 条续跑或重试，不再干等总超时。

7. **已落盘题包回收（仅普通出题）**
   - 总超时、静默卡死续跑用尽、非零退出或末尾缺少完成事件时，读取 `output/result.json`（缺失时按分片拼装）并执行与正常路径相同的 `validate`；通过即按成功返回并记录 `agy.result_recovered_from_disk`，未通过保持原失败。用户取消不回收。2026-11-18 有两题在磁盘已写出完整 `result.json` 后仍被 2 小时超时丢弃，此路径用于避免同类损失。

## 维护边界

- 子进程环境仅保留 `HOME`、`PATH`、`LANG`、`TMPDIR`、`USER`、`LOGNAME`、`AGY_HOME` 及代理变量，不透传数据库或供应商 API 密钥。
- 二进制默认优先读取 `AGY_BIN`，否则查找 `~/.local/bin/agy` 或 `PATH` 中的 `agy`。
