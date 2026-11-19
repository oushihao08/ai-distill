# 远程 CLI 操作流程

用于将**旧目录/旧项目内材料包工作流**的入库/兼容脱敏或**题目模型作答**经 SSH 隧道交由远程服务器执行。全局材料库（`library_v1`）不使用 `remote material`。

## 1. 前置条件（未确认前先只读核实）

1. 本机与服务器连接同一 PostgreSQL，服务器已应用 `034_remote_material_operations.sql`，且运行 `WORKER_MODE=server`、`MATERIAL_EXECUTION_TARGET=server`。
2. 旧工作流来源目录及项目 `materials/`、`skill/` 已同步至服务器相同可访问路径且指纹一致。
3. 本机建立本地回环隧道（CLI 拒绝非回环地址），且两端 `.env` 配置相同的 `REMOTE_MATERIAL_TOKEN`（>=32 字符，严禁写入命令行或对话）：

```sh
ssh -N -L 13700:127.0.0.1:37900 <user>@<server-host>
# 本机 .env：REMOTE_MATERIAL_API_URL=http://127.0.0.1:13700 与 REMOTE_MATERIAL_TOKEN=...
```

## 2. 命令与幂等恢复

每次新请求生成并保存独立 `request-key`（如 `uuidgen`）；超时或中断后**必须复用原 `workflow` + `request-key`** 查询或同步，禁止换 key 盲发：

```sh
# 旧工作流材料处理（redact/intake-redact 仅兼容全部附件已声明 declared_redacted，不跑模型脱敏）
bun run ai-distill remote material run --workflow <工作流UUID> --mode intake|redact|intake-redact --request-key <请求UUID> --json
bun run ai-distill remote material status --workflow <工作流UUID> --request-key <原请求UUID> --json
bun run ai-distill remote material sync --workflow <工作流UUID> --request-key <原请求UUID> --json

# 远程服务器模型作答（仅无步骤钩子题目；status 不含答案正文）
bun run ai-distill remote answer run|start|status --workflow <题目UUID> --request-key <请求UUID> --json
```

## 3. 能力边界

- **远程可执行**：旧工作流入库、PDF/DOCX 提取、`declared_redacted` 兼容处理、无钩子 `execution_target=server` 模型作答。
- **仅本机执行**：全局材料库本地 blob 任务、Agent 出题、独立评分、达标判定、归档导出与飞书交付。详见 [MAP.md](MAP.md#cli-工具地图) 与 [cli/README.md](../cli/README.md)。
