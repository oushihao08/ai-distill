# 本机工作流 CLI

这是现有HTTP API的可选命令行客户端。Codex操作Skill默认直接调用API；只有用户明确要求使用命令行时才按本文件操作。

Codex 或维护者通过 CLI 调用现有 Hono API，API 冻结输入并派发给现有 worker。普通本机命令不读数据库、不加载 `.env`，不另建模型执行器或调度器；远程命令按下文从本机 `.env` 读取专用 token。

远程命令是唯一需要本机凭证的入口：Bun 从本机 `.env` 读取 `REMOTE_MATERIAL_API_URL` 与 `REMOTE_MATERIAL_TOKEN`，通过 SSH 隧道连接服务器回环 API。材料命令发起入库、PDF 提取、API 脱敏并取回管理副本；作答命令让服务器按现有模型配置生成答案。两者都不执行 Agent。先确认服务器已同步对应材料包或旧模式题目的来源目录、运行数据库已应用 `034_remote_material_operations.sql`，并部署 `WORKER_MODE=server`、`MATERIAL_EXECUTION_TARGET=server` 的 worker。服务器 API 仅在 `MATERIAL_EXECUTION_TARGET=server` 且配置至少32字符 `REMOTE_MATERIAL_TOKEN` 时注册远程路由。本机通过 SSH 建立本地转发，例如：

```sh
ssh -N -L 13700:127.0.0.1:3700 <ssh-user>@<server-host>
# 本机 .env（不把实际令牌写入命令行或对话）
REMOTE_MATERIAL_API_URL=http://127.0.0.1:13700
REMOTE_MATERIAL_TOKEN=<与服务器REMOTE_MATERIAL_TOKEN相同的私有值>
```

将题目来源文件及项目 `materials/`、`skill/` 按项目部署方式放到服务器可访问的绝对路径。远程 `material` 和 `answer` 命令都按同一服务器 API 凭证认证；API 地址必须是本机回环地址，不能把 token 直接暴露到公网。`uuidgen` 为每次远程业务请求生成 request-key：

```sh
bun cli/index.ts remote material run --workflow <材料包UUID或旧模式题目UUID> --mode intake-redact --request-key <本次UUID>
bun cli/index.ts remote material status --operation <操作UUID>
bun cli/index.ts remote material sync --operation <操作UUID>
# 创建响应丢失时，按原题目和请求标识找回同一操作
bun cli/index.ts remote material status --workflow <材料包UUID或旧模式题目UUID> --request-key <本次UUID>
bun cli/index.ts remote material sync --workflow <材料包UUID或旧模式题目UUID> --request-key <本次UUID>
# 服务器作答；run 等待作答集合结束，start 仅提交，status 可按相同请求标识恢复查询
bun cli/index.ts remote answer run --workflow <题目UUID> --request-key <本次UUID>
bun cli/index.ts remote answer start --workflow <题目UUID> --request-key <本次UUID>
bun cli/index.ts remote answer status --workflow <题目UUID> --request-key <本次UUID>
```

`run` 一次提交并等待服务器完成，再下载本机所需原件副本和脱敏产物；`start` 只提交，`status` 查询服务器状态，`sync` 可在断线后继续本机文件收尾。只入库或只脱敏分别使用 `--mode intake`、`--mode redact`。相同题目、模式和请求标识重复提交返回同一操作；请求响应不确定时用原 `workflow` 和 `request-key` 查询或同步，不能生成新标识盲目重做。本机文件完整且指纹一致时才报告 `ready_for_local_authoring`；服务器成功但本机下载失败时继续运行 `sync`。CLI 只接受 localhost URL，以 SSH 隧道转发到服务器端口；不在命令行输入令牌。

远程作答复用既有 ordinal 5 队列：服务器只领取 `execution_target=server` 的作答 attempt；相同题目与请求标识重复提交返回原 attempt 集合，失败后若要显式重试须生成新请求标识。`status` 仅返回 attempt 状态和时间，不返回答案正文；共享数据库中的正常工作流页面和结果接口仍负责查看作答。服务器作答暂不支持项目步骤钩子；普通本机派发仍使用 `execution_target=local`，既有本地队列行为不变。

## 材料包多题命令

旧项目 `project create` 请求保持原样；新项目可加 `--material-mode material_packages`，`project sync` 仅登记来源材料包。已有项目要切换时用 `project material-mode --project <UUID> --clear-existing`，它会隐藏旧题，执行前先读项目及活动任务。`material-package list --project <UUID>` 查询材料包；`material-package versions --workflow <材料包UUID>` 列成功脱敏版本；`question create --material-package <材料包UUID> --redaction-attempt <成功脱敏尝试UUID> --title <题目名> [--scenario <场景>] [--role <角色>] [--level L2|L3|L4|L5] [--direction <方向>]` 建题。建题不再调用提取／脱敏；题目拥有自己的冻结整包快照。远程材料操作传材料包 ID，作答传题目 ID；旧项目仍传原题目 ID。`--all` 对材料步骤选择材料包、对出题及后续选择题目；明确 `--ids` 时以服务端身份校验为准。

## 能力总览与选择入口

CLI 是 API 客户端和少量本机文件工具。它不会直连数据库、启动服务、执行 SQL、实现第二套评分/达标算法，也不会自动把一个步骤推进到下一个步骤。

| 你要做的事 | 命令组 | 运行位置/对象 | 主要效果 |
| --- | --- | --- | --- |
| 查项目、题目、规则、模型、任务状态 | `project list/show`、`question list/show`、`workflow status`、`rules`、`models`、`attempt`、`monitor` | CLI → 本机 API | 只读；正文仅在明确读取完整题目/attempt 时返回 |
| 新建或调整项目及工作流配置 | `project create/update/delete/sync`、`project settings` | CLI → 本机 API | 写数据库或同步来源；删除须精确项目名，设置逐项应用 |
| 派发本机工作流步骤 | `step dispatch STEP_KEY` | CLI → 本机 API → 本机 worker | 单步派发；不自动继续，不替用户判断是否重新执行 |
| 固定一个批次和恢复范围 | `batch create/show/skip` | CLI → 本机 JSON 文件，创建时只读本机 API | 固定 workflow ID、分组、目标步骤和跳过原因；清单不是业务状态 |
| 等待已派发任务 | `attempt wait` | CLI → 本机 API | 默认只读状态元信息；到期/中断不取消后台任务 |
| 查询/下载成果和 Excel | `result`、`export list/create/download`、`artifact download` | CLI → 本机 API | 读取或显式生成/下载；下载仅写新文件，不覆盖 |
| 导出未达标题包或指定题目的复核包 | `export failed/review` | CLI → 本机 API并写仓库固定目录 | 依当前题目、作答、评分绑定导出文件；不改变工作流状态 |
| 让服务器执行入库、PDF提取、脱敏 | `remote material start/run/status/sync` | CLI → SSH 隧道 → 服务器 API/worker | 固定 request-key 幂等提交；成功后按哈希同步本机管理副本 |
| 让服务器执行模型作答 | `remote answer start/run/status` | CLI → SSH 隧道 → 服务器 API/worker | 创建/查找服务器归属的作答尝试；不返回答案正文 |

远程部署已具备源码路径不等于当前服务器已具备运行能力。远程命令仅能验证它连接到的服务实际返回；迁移、部署、共享数据库、文件挂载和 worker 状态应另行核对。

## 命令地图

所有命令均接受 `--json`；本机 API 命令接受 `--api`。旗标必须严格按命令支持的参数使用，未知参数会报错。完整简版语法可执行 `bun run ai-distill --help`。

| 命令 | 关键参数 | 读/写与行为 | 实现 |
| --- | --- | --- | --- |
| `project list` / `project show` | `--project UUID` | 只读项目及工作流清单 | `commands.ts` |
| `project create` | `--name`、`--material-root`；可选层级、skill、description、settings-file | 创建项目；之后可部分应用设置，不自动删除失败创建的项目 | `commands.ts` |
| `project update` | `--project` + 一个或多个更新字段 | 更新项目元数据、材料根或 skill 绑定；目录变更按 API 契约影响题目/结果 | `commands.ts` |
| `project delete` | `--project`、`--confirm-name` | 显式删除项目工作流数据；确认名必须完全匹配 | `commands.ts` |
| `project settings show/apply` | `--project`；apply另需 `--file JSON` | 读取或顺序应用 Codex、作答模型/阈值、步骤覆盖、作答时长策略 | `commands.ts` |
| `project sync` | `--project` | 按项目模式显式扫描题目或材料包来源目录；新模式不改变已建题目快照 | `commands.ts` → API扫描器 |
| `question list/show` | list用 `--project`；show用 `--workflow` | 题目清单或单题完整状态/结果 | `commands.ts` |
| `workflow status` | `--project` + `--ids` 或 `--all` | 当前状态、就绪原因及活动尝试摘要 | `commands.ts` |
| `rules list/file` | `--project`；file另需 `--path` | 读取项目规则清单/规则文件，不修改规则 | `commands.ts` |
| `models catalog/show` | show需 `--project` | 查看系统可选模型或项目模型及阈值 | `commands.ts` |
| `material text` | `--workflow`、`--material`、`--redacted-only` | 只读取当前脱敏正文；不能省略显式脱敏旗标 | `commands.ts` |
| `step list` / `step dispatch STEP_KEY` | dispatch需 `--project` + `--ids` 或 `--all` | 列出稳定 key，或仅派发单一步骤 | `commands.ts` + `shared/step-registry.ts` |
| `attempt show/wait` | show需 `--attempt`；wait需 `--ids`，可选 `--timeout`、`--full` | show读完整结果；wait默认状态投影，`--full` 才取正文 | `commands.ts` |
| `result list/show` | show需 `--workflow` | 当前达标成果摘要或单题工作流结果 | `commands.ts` |
| `monitor show` | 无 | 本机监控快照，不是供应商生成的页级进度 | `commands.ts` |
| `batch create` | `--project`、`--ids`或`--all`、`--size`、`--to`、`--out` | 创建权限600、不覆盖的本机批次 JSON；不派发任务 | `batches.ts` |
| `batch show/skip` | `--file`；skip另需 `--ids`、`--reason` | 读取清单或记录本轮跳过；不取消服务端任务 | `batches.ts` |
| `export list/create` | `--project`；create可选 `--batch` | 查询导出或显式生成项目 Excel | `commands.ts` / server reporting |
| `artifact download` / `export download` | 各自 ID、`--out` | 下载到不存在的新文件，父目录须已存在 | `client.ts` |
| `export failed/review` | `--project` + `--ids` 或 `--all`（review仅ids） | 固定目录导出未达标包/指定复核包，不写数据库状态 | `failed-export.ts` |
| `remote material start/run` | `--workflow`、`--mode`、`--request-key` | 提交服务器材料操作；run等待并自动sync | `remote-materials.ts` |
| `remote material status/sync` | `--operation` 或 `--workflow`+`--request-key` | 状态查询；sync在成功后校验并取回文件 | `remote-materials.ts` |
| `remote answer start/run/status` | `--workflow`、`--request-key` | 提交、等待或恢复查询服务器作答尝试集合 | `remote-answers.ts` |

代码定位和每组的服务器端边界另见 [Workflow Skill 工具地图](../skill/MAP.md#cli-工具地图)。

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

完整命令及参数见 `--help`。`project create` 与 `project update` 支持显式提供 `--parent-name` 和 `--phase-name`；同一主项目的期次复用主项目 skill 路径，未提供层级字段的旧调用继续按单项目处理。项目支持创建、修改、删除和项目设置读取／应用；`project create` 可通过 `--settings-file` 在创建后设置 Codex、作答模型集合、步骤配置和作答时长策略。命令会返回就绪检查；没有作答模型与有效阈值时会明确提示，不能把新项目误报成可完整评分。项目创建与 `project sync` 都通过现有服务端扫描器发现题目并切割超限 PDF：超过200页或超过单文件上限（默认50 MiB，可由服务端 `PDF_MAX_SIZE_MB` 调整）时按页拆分，单份同时不超过两项限制。CLI只调用本机API，不另行实现或执行一套切割器。派发一次只处理一个步骤；`--all` 先读取并固定指定项目当前题目 ID，按100题分组发送。不会默认重做已完成题、隐式同步来源、自动进入下一步。入库自身会按现有接口重新扫描题目目录；因此入库也必须在用户指定范围内执行。

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
| client.ts | localhost HTTP、JSON及下载响应、稳定错误；远程客户端只在内存中附加 Bearer token |
| remote-materials.ts | 远程材料请求、同键恢复、状态查询、清单/哈希核对和 `.storage/` 管理副本同步 |
| remote-answers.ts | 远程作答提交、start/run/status 和 request-key 恢复 |
| remote-materials.ts、remote-answers.ts | 读取本机远程凭证，分别闭环处理服务器材料操作与作答状态 |
| batches.ts | 本地批次清单创建、读取、固定分组及原子跳过记录，不保存业务状态 |
| failed-export.ts | 读取当前未达标判定与精确绑定的产物，按固定目录导出题目、作答及评分 |
| client.test.ts、commands.test.ts | 注入HTTP夹具的边界与流程测试；不连接数据库、不调用模型 |

定向单元测试使用完整路径：

```sh
bun test ./cli/client.test.ts ./cli/commands.test.ts
```

不要使用 `bun test cli`：Bun将它视为名称筛选，可能匹配其他目录的client测试。合成题目1流程验证命令契约，不能证明真实卷宗、正在运行的后端或Codex自主执行质量。操作Skill见 [SKILL.md](../skill/SKILL.md)。
