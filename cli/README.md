# 本机工作流 CLI

这是现有HTTP API的可选命令行客户端。Codex操作Skill默认直接调用API；只有用户明确要求使用命令行时才按本文件操作。

Codex 或维护者通过 CLI 调用现有 Hono API，API 冻结输入并派发给现有 worker。CLI 不读数据库、不加载 `.env`，不另建模型执行器或调度器。

## 入口

在仓库根目录执行 `bun run ai-distill --help`；任意目录可执行 `bun /绝对路径/ai-distill/cli/index.ts --help`。API 默认 `http://127.0.0.1:3700`，可用 `--api` 或 `AI_DISTILL_API_URL` 指定本机端口。只允许 localhost、127.0.0.1、::1，禁用 HTTP 重定向。使用现有 API/worker 启动方式，本工具不会代为启动。

```sh
bun run ai-distill project list --json
bun run ai-distill question list --project <项目UUID> --json
bun run ai-distill workflow status --project <项目UUID> --ids <题目UUID,...> --json
bun run ai-distill step list --json
bun run ai-distill step dispatch author_question --project <项目UUID> --ids <题目UUID,...> --json
bun run ai-distill attempt wait --ids <任务UUID,...> --timeout 1h --json
bun run ai-distill result show --workflow <题目UUID> --json
```

完整命令及参数见 `--help`。`project create` 与 `project update` 支持显式提供 `--parent-name` 和 `--phase-name`；同一主项目的期次复用主项目 skill 路径，未提供层级字段的旧调用继续按单项目处理。项目支持创建、修改、删除和项目设置读取／应用；`project create` 可通过 `--settings-file` 在创建后设置 Codex、作答模型集合、步骤配置和作答时长策略。命令会返回就绪检查；没有作答模型与有效阈值时会明确提示，不能把新项目误报成可完整评分。派发一次只处理一个步骤；`--all` 先读取并固定指定项目当前题目 ID，按100题分组发送。不会默认重做已完成题、隐式同步来源、自动进入下一步。入库自身会按现有接口重新扫描题目目录；因此入库也必须在用户指定范围内执行。

项目设置文件示例：

```json
{
  "codex": { "model": "gpt-6.1-sol", "reasoning_effort": "medium" },
  "models": [
    { "model_id": "系统模型UUID", "minimum_score": 50 }
  ],
  "steps": {
    "author_question": { "model": "gpt-6.1-sol", "reasoning_effort": "high", "prompt": "查看指定 skill，依据本次附件出题。" },
    "independent_score": { "model": "gpt-6.1-sol", "reasoning_effort": "medium", "prompt": "按题面和rubric逐项评分。" }
  },
  "answer_generation_policy": { "request_timeout_minutes": 60, "reasoning_threshold_minutes": 45, "skip_scoring_on_qualified_timeout": false }
}
```

各配置键可单独省略；`codex: null` 表示恢复全局 Codex 默认，`steps` 中支持恢复默认的步骤可用 `null`。`models` 必须提供至少一个已登记系统模型及其阈值，CLI不擅自替用户挑模型或设分数；先用 `models catalog` 查看可选模型，再用 `models show --project` 核对当前集合。设置按顺序调用现有 API；中途失败时此前成功项保留，返回已应用和未应用项，不自动回滚。`project update` 只提交指定字段并沿用其余当前值；改变材料根目录会按服务端契约同步发现题目，改变 skill 路径会使相关出题结果失效。

删除需要 `--confirm-name` 与当前项目名称完全一致。CLI删除的是项目数据库工作流数据；服务端保留项目配置容器及全局设置，不删来源目录、skill 和本地管理文件。删除是显式操作，不会由普通流程或 `--all` 隐式触发。

`material text` 需要题目 ID、材料 ID 和 `--redacted-only`，始终读取当前数据库脱敏产物。`question show`/`result show` 返回现有工作流详情，含当前题目、作答、评分、判定与产物清单；`attempt show` 按精确任务 ID 读取完整尝试，可能含敏感业务正文，仅按需使用。默认不输出原件正文或私有文件。

第七步在评分全部结束后自动计算达标状态；未达标题目由用户决定是否按普通步骤重新出题、作答和评分。`publish_export` 是归档步骤，`export create` 是单独的 Excel 操作。下载命令必须给 `--out`，父目录须存在，文件权限600且禁止覆盖已有文件。创建、修改、删除项目及应用设置均为显式写操作，按当前 API 的校验、事务和失效规则执行。

人工复核未达标题目时使用 `bun cli/index.ts export failed --project UUID --all --json`，或用 `--ids UUID,...` 限定题目。它只导出当前系统判定为 `repair` 且题目、作答、有效评分绑定齐全的记录，固定写入 [`assets/未达标题目/`](../assets/未达标题目/README.md)，不使用 `--out`，也不写入 `assets/out/`。每题保存出题文本、每个模型的作答与评分文本／JSON，以及带尝试 ID、版本和哈希的清单；同一判定重复调用只核对、不覆盖。未达标是业务判定，执行失败而缺少三项完整记录会在结果中报错。此命令不调用模型、不更改工作流状态。

明确指定已评分题目做作答质量复核，可用 `export review --project UUID --ids UUID,... --json` 导出同样的文件，即使系统判定已达标；清单保留真实 `accepted`／`repair`，不把模型低分冒充作答任务失败。此命令必须列明题目，不支持 `--all`。

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

`attempt wait` 默认请求 `view=status`，仅保留 id、workflow_id、ordinal、status、error、started_at、finished_at、completed 和单项 read_error，不读取题面、答案及评分正文；旧服务忽略视图时 CLI 仍投影这些字段。`attempt show` 或 `attempt wait --full` 可按需读取原有完整结果，HTTP 默认视图仍保留完整 result。服务端长轮询每秒查询一次，剩余预算不足1秒则只等待剩余时间；取消及时唤醒，不取消持久任务。无需正文时不使用 `--full`。

## 可配置批次清单

`batch create --project UUID --ids UUID,... --size N --to STEP_KEY --out PATH` 固定本轮范围并生成新JSON清单；也可用`--all`明确选择整个项目。`--size`必须显式给正整数，20不是固定值。创建时只读API确认题目属于项目，不派发任务。父目录须存在，清单权限600，不覆盖已有文件。

`batch show --file PATH` 返回按指定大小固定的有序分组，以及排除本轮跳过题后的ID。`batch skip --file PATH --ids UUID,... --reason 原因` 原子更新本轮跳过名单，不取消任务、不改数据库。并发更新使用短时锁，冲突时报告错误；异常退出遗留锁须先确认无调用再处理，不盲目删锁重试。

使用CLI批量处理时，可按skill逐组调用`workflow status`、`step dispatch`和`attempt wait`；清单不自动调度，也不记录题目状态和模型结果。恢复时读取清单和API状态，成功步骤不重做，本轮跳过题不再选入。新一轮处理失败题时新建清单。CLI原有每100题分请求是接口传输分组，与本次指定的业务批次大小不同。

同组内按题推进：每轮批量读取整组状态，将成功且下一授权步骤就绪的题按步骤分组派发，不等待全组完成同一步。没有可派发项时短等待后刷新整组；某题的慢任务不阻塞其他就绪题。本组全部到终点或记录跳过后再处理下一组。此规则由 Codex 按 skill 执行，不新增后台自动推进，也不改变 worker 并发、模型、工具权限或评分输入隔离。

清单包含项目/题目ID、批次大小、目标步骤、创建时间和跳过原因；不保存材料、题面、答案或凭证，跳过原因也应使用必要的安全摘要。

## 文件与验证

| 文件 | 职责 |
| --- | --- |
| index.ts | Bun入口、信号、输出与退出码 |
| commands.ts | 参数、API映射、分组派发与有限等待；步骤来自shared注册表 |
| client.ts | 本机HTTP、JSON及下载响应、稳定错误 |
| batches.ts | 本地批次清单创建、读取、固定分组及原子跳过记录，不保存业务状态 |
| failed-export.ts | 读取当前未达标判定与精确绑定的产物，按固定目录导出题目、作答及评分 |
| client.test.ts、commands.test.ts | 注入HTTP夹具的边界与流程测试；不连接数据库、不调用模型 |

定向单元测试使用完整路径：

```sh
bun test ./cli/client.test.ts ./cli/commands.test.ts
```

不要使用 `bun test cli`：Bun将它视为名称筛选，可能匹配其他目录的client测试。合成题目1流程验证命令契约，不能证明真实卷宗、正在运行的后端或Codex自主执行质量。操作Skill见 [SKILL.md](../skill/SKILL.md)。
