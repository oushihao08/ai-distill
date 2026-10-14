# 远程 CLI 操作流程

本文说明如何从本机项目把材料处理或模型作答交给远程服务器。远程 CLI 是本机 CLI 的一组命令，不需要在服务器另建项目；它通过共享数据库中的项目、材料包或题目 ID 找到任务，再经 SSH 隧道提交给服务器 API/worker。

## 前置条件

开始前确认：

- 本机项目及目标工作流已存在：新模式的材料处理使用材料包 `workflow_id`，作答使用题目 `workflow_id`；旧模式两者均使用题目 ID。
- 本机与服务器使用同一业务数据库；材料包或题目来源目录及项目 `materials/`、`skill/` 已同步到服务器，数据库保存的绝对路径在服务器可访问且内容指纹一致。
- 服务器已部署远程路由和 `WORKER_MODE=server` worker；API 设置 `MATERIAL_EXECUTION_TARGET=server`。运行数据库已登记 `034_remote_material_operations.sql`。
- 服务器和本机 `.env` 使用同一个 `REMOTE_MATERIAL_TOKEN`，长度至少32字符。本机 `.env` 设置 `REMOTE_MATERIAL_API_URL`。不要把 token 放入命令、日志或对话。
- 远程作答还要求项目已配置模型集合、评分上限/策略，服务器有对应模型供应商凭证。作答会调用模型并可能产生费用。

这些条件未知时先只读核实并标记未确认；CLI 命令存在或健康检查成功不能替代远程业务验收。

## 连接服务器

在本机终端建立 SSH 隧道并保持该终端运行。当前部署的服务器 API 端口为 `37900`；若部署配置变化，使用实际 API 端口：

```sh
ssh -N -L 13700:127.0.0.1:37900 <SSH用户>@<服务器地址>
```

SSH 会提示输入密码；终端输入时不会显示字符。然后在本机仓库根目录的 `.env` 中配置：

```dotenv
REMOTE_MATERIAL_API_URL=http://127.0.0.1:13700
REMOTE_MATERIAL_TOKEN=<与服务器相同的私有令牌>
```

CLI 只接受 localhost API 地址。隧道关闭后，远程 CLI 无法连接；不需要把服务端口开放到公网。

## 远程处理材料

确认目标材料工作流 ID 后，为本次请求生成并保存一个 request key：

```sh
uuidgen
```

将生成值用于远程入库、PDF 提取和脱敏：

```sh
bun run ai-distill remote material run \
  --workflow <材料包UUID或旧模式题目UUID> \
  --mode intake-redact \
  --request-key <本次UUID> \
  --json
```

`run` 会提交任务、等待服务器处理，并在成功后按 SHA-256 校验及同步管理副本到本机 `.storage/`。`intake` 只入库/提取，`redact` 只脱敏，`intake-redact` 执行两者。同步的管理副本不替代数据库中的工作流状态；继续本地出题前仍应检查工作流材料及脱敏步骤是否就绪。

## 远程处理作答

在题目、附件和项目作答模型已就绪且获准调用模型后，使用另一个新的 request key：

```sh
bun run ai-distill remote answer run \
  --workflow <题目UUID> \
  --request-key <本次UUID> \
  --json
```

命令等待本次全部模型作答尝试结束。状态结果不含答案正文；从共享数据库对应的工作流结果接口或工作台查看答案。服务器远程作答不支持项目步骤钩子。

## 中断与恢复

远程任务已提交后，本机终端中断不会取消服务器任务。保留原 `workflow_id` 与 request key，再恢复：

```sh
bun run ai-distill remote material status --workflow <材料包UUID或旧模式题目UUID> --request-key <原本次UUID> --json
bun run ai-distill remote material sync --workflow <材料包UUID或旧模式题目UUID> --request-key <原本次UUID> --json
bun run ai-distill remote answer status --workflow <题目UUID> --request-key <原本次UUID> --json
```

材料 `sync` 仅处理已成功的操作；服务器状态失败时先查看失败原因。不要因请求超时就换 key 重发；相同请求响应不确定时必须先按原 ID 查询。确需发起一次新的业务尝试时，先确认旧任务终态，再使用新 key。

## 能力边界

| 任务 | 执行位置 |
| --- | --- |
| 入库、PDF 提取、API 脱敏、无步骤钩子的模型作答 | 服务器 API/worker |
| Agent 出题、独立评分、达标判定、归档/导出 | 现有本机/API 流程；远程 worker 不执行 |

命令完整参数、响应和退出码见 [CLI 使用说明](../cli/README.md)；实现及接口定位见 [CLI 工具地图](MAP.md#cli-工具地图)。双机部署验收状态见 [远程 CLI 验收清单](../docs/plans/2026-10-14-remote-cli-acceptance.md)。
