# 本机工作流 CLI

Codex 或维护者通过 CLI 调用现有 Hono API，API 冻结输入并派发给现有 worker。CLI 不读数据库、不加载 `.env`，不另建模型执行器或调度器。

## 入口

在仓库根目录执行 `bun run ai-distill --help`；任意目录可执行 `bun /绝对路径/ai-distill/cli/index.ts --help`。API 默认 `http://127.0.0.1:3100`，可用 `--api` 或 `AI_DISTILL_API_URL` 指定本机端口。只允许 localhost、127.0.0.1、::1，禁用 HTTP 重定向。使用现有 API/worker 启动方式，本工具不会代为启动。

```sh
bun run ai-distill project list --json
bun run ai-distill question list --project <项目UUID> --json
bun run ai-distill workflow status --project <项目UUID> --ids <题目UUID,...> --json
bun run ai-distill step list --json
bun run ai-distill step dispatch author_question --project <项目UUID> --ids <题目UUID,...> --json
bun run ai-distill attempt wait --ids <任务UUID,...> --timeout 1h --json
bun run ai-distill result show --workflow <题目UUID> --json
```

完整命令及参数见 `--help`。派发一次只处理一个步骤；`--all` 先读取并固定指定项目当前题目 ID，按100题分组发送。不会默认重做已完成题、隐式同步来源、自动进入下一步。入库自身会按现有接口重新扫描题目目录；因此入库也必须在用户指定范围内执行。

`material text` 需要题目 ID、材料 ID 和 `--redacted-only`，始终读取当前数据库脱敏产物。`question show`/`result show` 返回现有工作流详情，含当前题目、作答、评分、判定、有限历史与产物清单；`attempt show` 按精确任务 ID 读取完整尝试，可能含敏感业务正文，仅按需使用。默认不输出原件正文或私有文件。

`revision start --source-attempt` 使用用户指定的失败判定尝试启动既有返修链；不是普通重出题。`publish_export` 是归档步骤，`export create` 是单独的 Excel 操作。下载命令必须给 `--out`，父目录须存在，文件权限600且禁止覆盖已有文件。创建项目和同步来源是显式写操作，会改变项目/材料清单；没有删除、重置或修改设置的命令。

## 状态和错误契约

除帮助文本外统一输出 JSON（显式 `--json` 便于 Agent 调用）。顶层 `outcome` 表示命令情况，`data` 保留 API 事实；派发含逐题 `dispatch`、分组 `batches`、精确选定范围和所有 `attempt_ids`。错误输出到 stderr，含 `kind`、可用的 HTTP 状态及 `request_id`；不转发非JSON响应正文、底层网络错误或凭证。

| 退出码 | 含义 |
| --- | --- |
| 0 | 查询完成、派发被接受或等待到终态；均不表示题目达标 |
| 1 | 参数、HTTP、文件或响应错误 |
| 2 | 部分派发失败/未就绪，或有失败任务/读取错误 |
| 3 | 等待到期仍有任务运行 |
| 130 | 收到中断，后台任务不被取消 |

`result show.business` 原样展示服务端第七步的执行状态及判定。模型分数、阈值和状态保留在 `data.steps` 与 `business.model_scores`，不由 CLI 重新算分。评分成功仍可能无效或未达标；缺判定时报告未知，不能推定通过。

等待上限1小时，GET单次等待不超过30秒；HTTP传输等待35秒是单次请求故障边界，不改变模型执行超时。读取故障保留其他任务结果，不取消任务；下次直接以同一 ID 读取。POST 永不自动重试，超时/断开/响应解析失败标记 `outcome_unknown`，先查状态再处理。后组派发失败保留此前已取得的任务 ID 和未发送范围。

## 文件与验证

| 文件 | 职责 |
| --- | --- |
| index.ts | Bun入口、信号、输出与退出码 |
| commands.ts | 参数、API映射、分组派发与有限等待；步骤来自shared注册表 |
| client.ts | 本机HTTP、JSON及下载响应、稳定错误 |
| client.test.ts、commands.test.ts | 注入HTTP夹具的边界与流程测试；不连接数据库、不调用模型 |

定向单元测试使用完整路径：

```sh
bun test ./cli/client.test.ts ./cli/commands.test.ts
```

不要使用 `bun test cli`：Bun将它视为名称筛选，可能匹配其他目录的client测试。合成题目1流程验证命令契约，不能证明真实卷宗、正在运行的后端或Codex自主执行质量。操作Skill见 [SKILL.md](../skill/SKILL.md)。
