# 本机工作流 CLI

这是现有HTTP API的可选命令行客户端。Codex 默认直接调用本机 API；只有用户明确要求使用命令行时才运行 CLI。本文件说明 CLI 的工作流程和安全边界；命令语法以 `bun run ai-distill --help` 与 `cli/commands.ts` 的 HELP 为准。

Codex 或维护者通过 CLI 调用现有 Hono API，API 冻结输入并派发给现有 worker。普通本机命令不读数据库、不发送服务端凭证，不另建模型执行器或调度器；Bun运行时可按正常方式加载环境，命令只使用其声明的配置；远程命令按下文从本机 `.env` 读取专用 token。

远程命令是唯一需要本机凭证的入口：Bun 从本机 `.env` 读取 `REMOTE_MATERIAL_API_URL` 与 `REMOTE_MATERIAL_TOKEN`，通过 SSH 隧道连接服务器回环 API。材料命令发起入库、PDF 提取、人工声明已脱敏的兼容处理并取回管理副本；作答命令让服务器按现有模型配置生成答案。两者都不执行 Agent。材料组合命令只接受旧项目内材料包或旧目录题目的workflow ID，不接受全局材料库package/revision/job ID。先确认服务器已同步这些工作流的来源目录、运行数据库已应用 `034_remote_material_operations.sql`，并部署 `WORKER_MODE=server`、`MATERIAL_EXECUTION_TARGET=server` 的 worker。服务器 API 仅在 `MATERIAL_EXECUTION_TARGET=server` 且配置至少32字符 `REMOTE_MATERIAL_TOKEN` 时注册远程路由。本机通过 SSH 建立本地转发，例如：

**远程 CLI 只调用服务器已开放的 API 能力，不会在服务器启动 Codex Agent。**当前远程范围是入库、PDF/DOCX 提取、人工声明已脱敏的兼容处理和模型作答；不能通过远程命令运行 Agent 出题或 Agent 评分。出题和 Agent 评分仍需在有 Codex 的本机环境，通过本机 API/worker 执行。若步骤选择大模型 API 评分，应按本机 API 工作流执行；远程服务器 worker 当前不领取评分队列。

```sh
ssh -N -L 13700:127.0.0.1:3700 <ssh-user>@<server-host>
# 本机 .env（不把实际令牌写入命令行或对话）
REMOTE_MATERIAL_API_URL=http://127.0.0.1:13700
REMOTE_MATERIAL_TOKEN=<与服务器REMOTE_MATERIAL_TOKEN相同的私有值>
```

将题目来源文件及项目 `materials/`、`skill/` 按项目部署方式放到服务器可访问的绝对路径。远程 `material` 和 `answer` 命令都按同一服务器 API 凭证认证；API 地址必须是本机回环地址，不能把 token 直接暴露到公网。`uuidgen` 为每次远程业务请求生成 request-key：

```sh
bun cli/index.ts remote material run --workflow <旧材料工作流UUID> --mode intake-redact --request-key <本次UUID>
bun cli/index.ts remote material status --operation <操作UUID>
bun cli/index.ts remote material sync --operation <操作UUID>
# 创建响应丢失时，按原题目和请求标识找回同一操作
bun cli/index.ts remote material status --workflow <旧材料工作流UUID> --request-key <本次UUID>
bun cli/index.ts remote material sync --workflow <旧材料工作流UUID> --request-key <本次UUID>
# 服务器作答；run 等待作答集合结束，start 仅提交，status 可按相同请求标识恢复查询
bun cli/index.ts remote answer run --workflow <题目UUID> --request-key <本次UUID>
bun cli/index.ts remote answer start --workflow <题目UUID> --request-key <本次UUID>
bun cli/index.ts remote answer status --workflow <题目UUID> --request-key <本次UUID>
```

`run` 一次提交并等待服务器完成，再下载本机所需原件副本和脱敏产物；`start` 只提交，`status` 查询服务器状态，`sync` 可在断线后继续本机文件收尾。只入库使用 `--mode intake`；`--mode redact` 仅兼容人工已脱敏声明。相同题目、模式和请求标识重复提交返回同一操作；请求响应不确定时用原 `workflow` 和 `request-key` 查询或同步，不能生成新标识盲目重做。本机文件完整且指纹一致时才报告 `ready_for_local_authoring`；服务器成功但本机下载失败时继续运行 `sync`。全局库的 `library job --target server`另要求该revision所有blob的storage_target匹配；当前普通上传只建立local blob，remote material不自动迁移库级文件。CLI 只接受 localhost URL，以 SSH 隧道转发到服务器端口；不在命令行输入令牌。

远程作答复用既有 ordinal 5 队列：服务器只领取 `execution_target=server` 的作答 attempt；相同题目与请求标识重复提交返回原 attempt 集合，失败后若要显式重试须生成新请求标识。`status` 仅返回 attempt 状态和时间，不返回答案正文；共享数据库中的正常工作流页面和结果接口仍负责查看作答。服务器作答暂不支持项目步骤钩子；普通本机派发仍使用 `execution_target=local`，既有本地队列行为不变。

远程 `redact`／`intake-redact` 不执行 API 模型脱敏，只兼容全部附件均为 `declared_redacted` 的旧工作流。需要生成化名时使用本机共享材料库 Agent；旧模式有任一附件需要模型处理即拒绝。

## 共享材料库与期次

项目目录使用仓库相对引用，如`--workspace-path projects/豆包高经济价值/第六期 --skill-path projects/豆包高经济价值/skill`。创建/修改均由API校验本机目录存在并保存相对路径；仓库内绝对输入仍可接受，不能新绑定仓库外目录。`project update --workspace-path`用于调整材料库期次工作区；只是同一目录的表示变化不失效结果。规则与历史兼容见[项目目录契约](../server/README.md#项目目录与多机路径)。材料上传清单、下载输出目录等本机文件参数保持各自契约。

材料处理仅两种：默认Agent化名使用`library job start --kind redact --extraction-job UUID --project 期次UUID`；原文无需脱敏，直接使用成功提取版本。新任务模板固定codex_plan，历史mask读取保留但不得再派发。任务读取并冻结数据库提示词，使用本次冻结执行预算，到限不自动重试。

计划导入和导出共用服务端采用的格式校验；模板身份与摘要须成对提供。旧计划完全不带模板字段时保留兼容。导出成功只证明来源、精确编辑及覆盖有效；正式导入还需核对当前模板、活动任务和数据库事务。重放原导入请求须保留原plan与request-key，不能修改plan后复用旧key。

全局材料包不隶属于单个项目；主项目用稳定 group ID 关联多个期次，每期仍是独立 project/workflow 范围。创建新期次用 `project create --material-backend library_v1 --workspace-path <仓库相对路径> --parent-name <主项目> --phase-name <期名> --phase-no <正整数>`，或用 `--project-group UUID` 关联已有主项目。缺省backend为library_v1；旧目录创建须显式指定legacy。首期必须以--skill-path明确共享Skill目录，后续期次复用主项目既有路径。

仅指定`--project-group`时，CLI先读取该ID的当前主项目名称再创建期次；显式给出`--parent-name`仍由服务端核对一致性。不能用期次显示名称代替主项目名称。

`project update`更新材料库期次的名称、说明或Skill时不要求旧式`material_root`，也不重新提交未修改的推断Skill路径；旧目录项目仍带上当前材料目录。材料库期次的材料来自加载关系，不用`--material-root`替换。

常用路径：

1. `project-group list` / `project-group phases --group UUID` 查看主项目和期次；`project show --project UUID` 核对当前期次与工作流。
2. `library package list` 搜索全局材料包，`library package show --package UUID` 查看当前版本，`library package revisions --package UUID` 查看版本，`library package usage --package UUID` 查看使用历史。
3. `library revision create --package UUID --version N --request-key UUID --manifest JSON` 上传文件并创建不可变 revision。清单示例（相对路径以清单文件所在目录为准）：

   ```json
   {
     "files": [
       { "path": "材料/合同.pdf", "redaction_mode": "model" },
       { "path": "材料/已脱敏.docx", "redaction_mode": "declared_redacted" }
     ]
   }
   ```

   `files` 必须为 1–100 项；每项可省略 `redaction_mode`（默认 `model`）。提交带 `If-Match` 版本，文件上传按清单逐项读取。对相同的已知请求不要另造 request-key 重复创建；POST 结果未知时先查对应 API/任务，不盲目重放。
4. 对 revision 执行入库、提取或脱敏：`library job start --revision UUID --kind intake|extract|redact --target local|server --request-key UUID`；指定提取/前序任务时使用 `--extraction-job`、`--previous-job`。用 `library job show --job UUID` 查看任务，以当前 API/worker 状态确认完成。CLI 提交任务，处理由现有 worker 执行。
5. 从 `project material candidates --project UUID [--source-mode any|redacted|original]` 找材料；`project materials load --project UUID --package UUID (--redaction UUID | --revision UUID)` 加载到当前期。按期次的出题设置选择模式，通常脱敏结果使用 `--redaction`，原文模式需指定已提取 revision。
6. `project materials list --project UUID [--include-removed]` 查看已加载项。选版、排序、移除、恢复都要带当前 `--version`；CLI 使用 `If-Match`，冲突时先刷新再作决定。
7. `project materials question --project UUID --link UUID --version N (--redaction UUID | --revision UUID) --title 名称 --request-key UUID` 创建题目，可选角色、场景、等级、方向和标签。它冻结本题材料来源；后续 workflow 以题目 UUID 操作，不能用 package/revision ID 派发出题、作答或评分。
8. `project material uses --project UUID` 查看材料在本期的使用摘要；`project material use events --project UUID --use UUID` 查看事件；`project material use update` 用于有依据的返修/提交状态变更，必须携带版本、原因，支持 `--evidence-file JSON`。

材料正文查看：`library documents show --revision UUID --extraction-job UUID [--file UUID]`、`library redaction show --redaction UUID [--file UUID]`。原件下载 `library file download --file UUID --out <新文件路径>` 仅写入新文件且不覆盖。

旧目录项目和旧 `material_packages` 多题路径继续兼容；这是系统对历史数据和旧流程的兼容能力，不代表每个业务项目都允许一包多题。Work法律全场景按[项目规则](../projects/Work法律全场景/AGENTS.md)执行一个材料包对应一道题；`project sync` 与 `material-package` 命令不等同于全局材料库。`project material-mode --project UUID --clear-existing` 是显式迁移旧项目到材料包模式的兼容命令：服务端会软隐藏该项目当前旧题并将已有导出标为失效，项目有活动任务时拒绝切换；不要将它用于日常加载材料或新建 `library_v1` 期次。旧数据导入先 `project legacy-materials list`，再用 `project legacy-materials import --project UUID --workflow UUID --request-key UUID` 做 dry-run；确认来源摘要后才加 `--apply --digest SHA256`，随后按返回 ID 调用 `activate`。导入的是旧材料原件/成功提取结构，不会伪装成重新脱敏，且不修改旧题快照。

写请求使用幂等 request-key 或版本锁的命令按其 API 契约执行；CLI 不会对 POST 自动重试。版本冲突先读取最新状态，网络结果未知先用已有 ID/request-key 查询。材料任务派发成功只代表任务已被接受，是否完成以任务终态为准。

## 能力总览与选择入口

CLI 是 API 客户端和少量本机文件工具。它不会直连数据库、启动服务、执行 SQL、实现第二套评分/达标算法，也不会自动把一个步骤推进到下一个步骤。材料库与期次命令见上节；其他命令的精确语法以 `--help` 为准，避免在多个文档维护重复的完整参数表。

| 你要做的事 | 命令组 | 运行位置/对象 | 主要效果 |
| --- | --- | --- | --- |
| 查项目、题目、规则、模型、任务状态 | `project list/show`、`question list/show`、`workflow status`、`rules`、`models`、`attempt`、`monitor` | CLI → 本机 API | 只读；正文仅在明确读取完整题目/attempt 时返回 |
| 新建或调整项目及工作流配置 | `project create/update/delete/sync`、`project settings` | CLI → 本机 API | 写数据库或同步来源；删除须精确项目名，设置逐项应用 |
| 派发本机工作流步骤 | `step dispatch STEP_KEY` | CLI → 本机 API → 本机 worker | 单步派发；不自动继续，不替用户判断是否重新执行 |
| 固定一个批次和恢复范围 | `batch create/show/skip` | CLI → 本机 JSON 文件，创建时只读本机 API | 固定 workflow ID、分组、目标步骤和跳过原因；清单不是业务状态 |
| 等待已派发任务 | `attempt wait` | CLI → 本机 API | 默认只读状态元信息；到期/中断不取消后台任务 |
| 查询/下载成果和 Excel | `result`、`export list/create/download`、`artifact download`、`siriser download` | CLI → 本机 API | 读取或显式生成/下载；下载仅写新文件，不覆盖 |
| 导出未达标题包或指定题目的复核包 | `export failed/review` | CLI → 本机 API并写仓库固定目录 | 依当前题目、作答、评分绑定导出文件；不改变工作流状态 |
| 让服务器执行入库、PDF提取、人工声明处理 | `remote material start/run/status/sync` | CLI → SSH 隧道 → 服务器 API/worker | 固定 request-key 幂等提交；成功后按哈希同步本机管理副本 |
| 让服务器执行模型作答 | `remote answer start/run/status` | CLI → SSH 隧道 → 服务器 API/worker | 创建/查找服务器归属的作答尝试；不返回答案正文 |

远程部署已具备源码路径不等于当前服务器已具备运行能力。远程命令仅能验证它连接到的服务实际返回；迁移、部署、共享数据库、文件挂载和 worker 状态应另行核对。

## 核心命令地图

所有命令均接受 `--json`；本机 API 命令接受 `--api`。旗标必须严格按命令支持的参数使用，未知参数会报错。下表仅说明主要对象与影响，完整简版语法可执行 `bun run ai-distill --help`。

| 命令 | 关键参数 | 读/写与行为 | 实现 |
| --- | --- | --- | --- |
| `project list` / `project show` | `--project UUID` | 只读项目及工作流清单 | `commands.ts` |
| `project create` | `--name`；`--material-backend legacy --material-root` 或 `--material-backend library_v1 --workspace-path`；可选主项目/期次字段 | 创建 legacy 项目或绑定共享材料库的期次；之后可部分应用设置 | `commands.ts` |
| `project update` | `--project` + 一个或多个更新字段 | 更新项目元数据、材料根或 skill 绑定；目录变更按 API 契约影响题目/结果 | `commands.ts` |
| `project delete` | `--project`、`--confirm-name` | 显式删除项目工作流数据；确认名必须完全匹配 | `commands.ts` |
| `project settings show/apply` | `--project`；apply另需 `--file JSON` | 读取或顺序应用 Codex、作答模型/阈值、步骤覆盖、作答时长策略 | `commands.ts` |
| `project sync` | `--project` | 仅扫描有material_root的旧目录/项目内材料包来源；library_v1使用独立库任务与加载命令 | `commands.ts` → API扫描器 |
| `project-group` / `project phase-update` | `--group` 或 `--project`、期次字段 | 主项目期次导航、改名、归档/恢复及期次身份更新 | `commands.ts` → `server/project-groups.ts` |
| `library package/revision/job` | 包 ID、revision ID、任务 kind 与 request-key | 全局包、不可变文件版本及入库/提取/脱敏任务 | `commands.ts` → `server/material-library/` |
| `project materials` / `project material use` | 期次、link/use ID、来源版本、版本锁 | 加载材料、选版、创建题目及查看/更新永久使用台账 | `commands.ts` → `projects-routes.ts`、`uses.ts` |
| `question list/show` | list用 `--project`；show用 `--workflow` | 题目清单或单题完整状态/结果 | `commands.ts` |
| `question delete` | `--project`、`--workflow`、`--confirm-title` | 精确核对期次、题目类型和标题后软删除单题；有活动尝试时拒绝 | `commands.ts` → `DELETE /api/workflows/:id` |
| `workflow status` | `--project` + `--ids` 或 `--all` | 当前状态、就绪原因及活动尝试摘要 | `commands.ts` |
| `workflow design update` | `--workflow` + 一个或多个 `--direction`、`--scenario`、`--role` | 更新既有题目的出题设计输入；值变化时会重置步骤4—8并使相关导出失效 | `commands.ts` → `PATCH /api/workflows/:id/authoring-direction` |
| `workflow authoring restore` | `--workflow UUID --attempt UUID` | 恢复已保存且可恢复的出题结果；不重新调用模型 | `POST /api/workflows/:id/authoring-results/:attemptId/restore` |
| `workflow archive withdraw` | `--workflow UUID` | 显式撤回归档，保留历史；重新执行仍需单独派发 | `POST /api/workflows/:id/withdraw-archive` |
| `library redaction revalidate` | `--redaction UUID` | 复核已发布Agent产物，追加复核记录；不修改原文、旧题快照或自动重新脱敏 | `POST /api/material-library/redactions/:id/revalidate` |
| `workflow hooks show` | `--workflow UUID` | 读取钩子状态、错误及检查点标记 | `GET /api/workflows/:id/hooks` |
| `hook retry` | `--hook UUID [--acknowledge-side-effects]` | 显式同步补执行；非幂等副作用确认仅在指定旗标时发送 | `POST /api/hooks/:id/retry` |
| `attempt resume-hooks` | `--attempt UUID [--acknowledge-side-effects]` | 兼容旧主尝试的钩子失败续跑，不代替新后置钩子补执行 | `POST /api/attempts/:id/resume-hooks` |
| `workflow delivery show` | `--workflow UUID` | 只读归档状态、最近及逐目标飞书回执；查询成功不等于交付成功 | `GET /api/workflows/:id?view=status` |
| `workflow material-docx generate` | `--workflow UUID` | 按题目冻结材料和项目布局生成/复用全部材料DOCX，返回完整`artifacts[]`；不派发作答、评分或归档 | `POST /api/workflows/:id/material-docx` |
| `rules list/file` | `--project`；file另需 `--path` | 读取项目规则清单/规则文件，不修改规则 | `commands.ts` |
| `models catalog/show` | show需 `--project` | 查看系统可选模型或项目模型及阈值 | `commands.ts` |
| `material text` | `--workflow`、`--material`、`--redacted-only` | 只读取当前脱敏正文；不能省略显式脱敏旗标 | `commands.ts` |
| `step list` / `step dispatch STEP_KEY` | dispatch需 `--project` + `--ids` 或 `--all` | 列出稳定 key，或仅派发单一步骤；无效评分且达标判断等待时可显式重派独立评分 | `commands.ts` + `shared/step-registry.ts` |
| `attempt show/wait` | show需 `--attempt`；wait需 `--ids`，可选 `--timeout`、`--full` | show读完整结果；wait默认状态投影，`--full` 才取正文 | `commands.ts` |
| `result list/show` | show需 `--workflow` | 当前达标成果摘要或单题工作流结果 | `commands.ts` |
| `monitor show` | 无 | 本机监控快照，不是供应商生成的页级进度 | `commands.ts` |
| `batch create` | `--project`、`--ids`或`--all`、`--size`、`--to`、`--out` | 创建权限600、不覆盖的本机批次 JSON；不派发任务 | `batches.ts` |
| `batch show/skip` | `--file`；skip另需 `--ids`、`--reason` | 读取清单或记录本轮跳过；不取消服务端任务 | `batches.ts` |
| `export list/create` | `--project`；create可选 `--batch` | 查询导出或显式生成项目 Excel | `commands.ts` / server reporting |
| `artifact download` / `export download` | 各自 ID、`--out` | 下载到不存在的新文件，父目录须已存在 | `client.ts` |
| `siriser download` | `--workflow UUID --out 路径` | 下载该题当前有效归档的 Siriser 五件套 ZIP；需已成功归档，目标文件不得存在 | `commands.ts` → `GET /api/workflows/:id/siriser-zip` |
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

完整命令及参数见 `--help`。`project create` 与 `project update` 支持显式提供 `--parent-name` 和 `--phase-name`；同一主项目的期次复用主项目 skill 路径，未提供层级字段的旧调用继续按单项目处理。项目支持创建、修改、删除和项目设置读取／应用；`project create` 可通过 `--settings-file` 在创建后设置 Codex、作答模型集合、步骤配置和作答时长策略。命令会返回就绪检查；没有作答模型与有效阈值时会明确提示，不能把新项目误报成可完整评分。旧目录项目创建与 `project sync` 通过服务端扫描器发现题目并切割超限 PDF；library_v1创建不扫描题目目录，不能调用sync代替材料库上传。旧目录PDF处理边界：超过200页或超过单文件上限（默认50 MiB，可由服务端 `PDF_MAX_SIZE_MB` 调整）时按页拆分，单份同时不超过两项限制。CLI只调用本机API，不另行实现或执行一套切割器。派发一次只处理一个步骤；`--all` 先读取并固定指定项目当前题目 ID，按100题分组发送。不会默认重做已完成题、隐式同步来源、自动进入下一步。入库自身会按现有接口重新扫描题目目录；因此入库也必须在用户指定范围内执行。

项目设置文件示例：

```json
{
  "codex": { "model": "gpt-6.1-sol", "reasoning_effort": "medium" },
  "models": [
    { "model_id": "系统模型UUID", "minimum_score": 50 }
  ],
  "steps": {
    "author_question": { "model": "gpt-6.1-sol", "reasoning_effort": "high", "material_processing_mode": "aliases", "material_source_mode": "redacted", "prompt": "查看指定 skill，依据本次附件出题。" },
    "independent_score": { "model": "gpt-6.1-sol", "reasoning_effort": "medium", "prompt": "按题面和rubric逐项评分。" },
    "accept_or_revise": { "aggregation": { "mode": "mean_at_most", "model_count": 2, "threshold": 50 } }
  },
  "answer_generation_policy": { "request_timeout_minutes": 60, "reasoning_threshold_minutes": 45, "skip_scoring_on_qualified_timeout": false }
}
```

各配置键可单独省略；`codex: null` 表示恢复全局 Codex 默认，`steps` 中支持恢复默认的步骤可用 `null`。新 `library_v1` 题目的 `author_question.material_source_mode` 可设为 `redacted` 或 `original`，省略时服务端默认为 `redacted`；该选择只影响之后创建的题目，并由题目快照冻结，已有题目不切换来源。`models` 必须提供至少一个已登记系统模型及其阈值，CLI不擅自替用户挑模型或设分数；先用 `models catalog` 查看可选模型，再用 `models show --project` 核对当前集合。设置按顺序调用现有 API；中途失败时此前成功项保留，返回已应用和未应用项，不自动回滚。`project update` 只提交指定字段并沿用其余当前值；改变材料根目录会按服务端契约同步发现题目，改变 skill 路径会使相关出题结果失效。

`steps` 可配置 `author_question`、`model_answer`、`independent_score`、`accept_or_revise`。达标 `{}` 恢复逐模型严格分数上限，`aggregation` 显式选择均分规则；均分例子只适用于用户指定的模型数量和门槛，不是默认值。修改达标配置会由服务端使当前判定、归档及相关导出失效；CLI不主动重算或重新派发。达标配置不接受 `null` 删除，使用 `{}`。仅出题、评分配置支持 `null` 恢复默认。

API 评分时，将 `steps.independent_score` 替换为以下对象（不会修改项目作答模型集合）：

```json
{ "provider": "api", "api": { "provider": "openrouter", "base_url": "https://openrouter.ai/api/v1", "model": "deepseek/deepseek-v4.1-flash" }, "prompt": "按题面和rubric逐项评分。" }
```

模型和供应商是配置示例，不代表本机额度或供应商已验收；凭证由服务端解析，不能写进设置文件。项目 Agent 默认仍使用兼容键 `codex`，步骤覆盖及新任务配置冻结由服务端管理。设置与执行语义分别见 [Agent](../server/agent/README.md)、[API调用](../server/llm-api/README.md)、[评分](../server/scoring/README.md)。CLI不提供独立底层模型调用入口，也不绕过业务队列。

删除需要 `--confirm-name` 与当前项目名称完全一致。CLI删除的是项目数据库工作流数据；服务端保留项目配置容器及全局设置，不删来源目录、skill 和本地管理文件。删除是显式操作，不会由普通流程或 `--all` 隐式触发。

`material text` 需要题目 ID、材料 ID 和 `--redacted-only`，始终读取当前数据库脱敏产物。`question show`/`result show` 返回现有工作流详情，含当前题目、作答、评分、判定与产物清单；`attempt show` 按精确任务 ID 读取完整尝试，可能含敏感业务正文，仅按需使用。默认不输出原件正文或私有文件。

第八步异步派发：HTTP返回任务ID，使用attempt wait等待本地归档终态；Work必需五件套在归档前完成，豆包飞书在归档后同步并保存独立回执。不以派发202或本地归档成功作为外部交付证明。各项目继续使用自身交付脚本和成果契约。

第七步在评分全部结束后自动计算达标状态；未达标题目由用户决定是否按普通步骤重新出题、作答和评分。`publish_export` 是归档步骤，`export create` 是单独的 Excel 操作。下载命令必须给 `--out`，父目录须存在，文件权限600且禁止覆盖已有文件。创建、修改、删除项目及应用设置均为显式写操作，按当前 API 的校验、事务和失效规则执行。

Work 五件套的 CLI 流程：先用 `step dispatch publish_export --project UUID --ids 题目UUID` 派发第八步；按返回的 `attempt_ids` 用 `attempt wait` 等待终态；再用 `result show --workflow 题目UUID` 核对服务端达标与归档状态，最后执行 `siriser download --workflow 题目UUID --out 新路径.zip`。下载 API 会重新核对当前 accepted 版本、归档输入摘要和包内文件哈希；题目或 Rubric 已变化、归档失效或包被篡改时拒绝下载。该命令只下载本机 ZIP，不上传到 Siriser，也不执行“提交出题”。Harbor 六件套由独立转换流程处理，不包含在该命令中。

人工复核未达标题目时使用 `bun cli/index.ts export failed --project UUID --all --json`，或用 `--ids UUID,...` 限定题目。它只导出当前系统判定为 `repair` 且题目、作答、有效评分绑定齐全的记录，固定写入 `assets/未达标题目/`（首次运行时由 `cli/failed-export.ts` 创建），不使用 `--out`，也不写入 `assets/out/`。每题保存出题文本、每个模型的作答与评分文本／JSON，以及带尝试 ID、版本和哈希的清单；同一判定重复调用只核对、不覆盖。未达标是业务判定，执行失败而缺少三项完整记录会在结果中报错。此命令不调用模型、不更改工作流状态。

明确指定已评分题目做作答质量复核，可用 `export review --project UUID --ids UUID,... --json` 导出同样的文件，即使系统判定已达标；清单保留真实 `accepted`／`repair`，不把模型低分冒充作答任务失败。此命令必须列明题目，不支持 `--all`。

## 已有题目的返修设计输入

修改既有题目的角色、场景或出题方向可运行：

```sh
bun run ai-distill workflow design update --workflow <题目UUID> --direction <新出题方向> --scenario <场景> --role <角色视角>
```

至少提供一个字段；未提供的字段保持原值，传入空文本（例如 `--direction ""`）清空该字段。只有值实际变化时，服务端才重置 ordinal 4—8、使活动尝试失效并标记相关导出过期。该命令不派发出题；设置确认后仍须显式执行 `step dispatch author_question`，再按普通步骤重新作答和评分。全局材料包工作流不支持此接口。

## 显式恢复与交付确认

先读取原 workflow／attempt／hook ID 的状态与错误，再选择恢复入口；写请求响应未知时继续查询同一对象，不自动重试。

- 已有出题保存检查点：`workflow authoring restore` 复用原结果，服务端决定是否仍可恢复，不能用它覆盖新版本。
- 脱敏复核：`library redaction revalidate` 仅复核Agent已发布产物；`valid=false` 或 `usable_for_question=false` 返回部分失败，不自动生成新任务。
- 钩子失败：先 `workflow hooks show`；新后置增强用 `hook retry`，旧失败主尝试才用 `attempt resume-hooks`。未指定 `--acknowledge-side-effects` 时发送false，副作用不明或运行中的拒绝由服务端保留，不能为绕过拒绝自动补确认。同步补执行HTTP最多等待180秒；超时不表示服务端未执行，先读原hook状态。续跑命令只返回接受回执，随后按原attempt查询。
- 归档后返修：先显式 `workflow archive withdraw`，再按用户要求修改设计／派发；撤回不释放主项目材料历史使用记录。
- `attempt wait` 的 `completion_scope=attempt` 只确认尝试终态。豆包飞书尾段在本地归档后运行，另用 `workflow delivery show` 读取最近及逐目标回执；`outcome=complete` 只代表查询完成。核对准确目标、当前版本和 `status=succeeded`、`verification.status=passed`；缺失、旧回执或旧服务不含逐目标字段均保持未知。该查询不实时访问飞书；远端现状不确定时不能宣称仍已交付。`unknown`／`dispatching` 先核实远端，只有明确失败或缺失才在授权内显式补传，不重新归档。

## 状态和错误契约

### Codex材料计划的本地导出

`library documents export --plan 私有计划.json --out 新目录` 由 CLI 通过 HTTP 重新读取已入库提取原文，验证来源摘要，应用 Codex 明确给出的编辑，再按材料范围生成独立 Markdown、正文 JSON 和材料清单。它不运行模型、不重新OCR、不入库、不派发后续任务；自然人关联、代称和分册判断由 Codex 按项目 Skill 先完成。执行成功仅证明机械校验及文件写入，不证明脱敏无遗漏或文书边界正确。

计划 `format=codex-material-export-v1`，包含 `revision_id`、`extraction_job_id`、`files[{file_id,text_sha256}]`、`edits[{file_id,page,start,end,source_text,replacement_text}]`、`documents[{id,title,segments[{file_id,page,start,end}]}]`，以及可选安全 `notes`。文件摘要是该文件所有页原文按 `\n` 拼接后的UTF-8 SHA256；偏移使用JavaScript UTF-16、左闭右开，编辑定位原文，分册定位编辑后的页文本。全部附件、非空处理后页必须完整覆盖；重叠编辑、来源变化、分册遗漏/重复被拒绝；标题与安全文件名分开，空标题使用序号、非法文件名字符自动净化，序号防止同名覆盖。计划包含原文片段，只能私有保存，不放入交付目录。输出目录必须不存在；写入失败清理本次创建目录。正文不添加原页定位和识别提示，来源范围留在私有计划。

`material-export.ts` 实现上述机械处理，`commands.ts` 仅分发命令。项目操作 Skill 见 `projects/Work法律全场景/material-prep/SKILL.md`。

`library documents import --plan 私有计划.json --request-key UUID` 将同一计划通过 HTTP 正式保存为新的库级脱敏结果，不重新上传或OCR。返回 `job_id`、`redaction_id`、摘要及计数后，再用 `library redaction show` 读回。相同键与相同计划复用同一结果，计划变化必须使用新请求；响应未知先以原键重试核对，不换键盲发。它不调用模型，Codex判断由前置Skill完成；不自动建题或推进。该结果的分册元数据随新题冻结，旧题不改写。

除帮助文本外统一输出 JSON（显式 `--json` 便于 Agent 调用）。顶层 `outcome` 表示命令情况，`data` 保留 API 事实；派发含逐题 `dispatch`、分组 `batches`、精确选定范围和所有 `attempt_ids`。错误输出到 stderr，含 `kind`、可用的 HTTP 状态及 `request_id`；不转发非JSON响应正文、底层网络错误或凭证。

| 退出码 | 含义 |
| --- | --- |
| 0 | 查询完成、派发被接受或等待到终态；均不表示题目达标 |
| 1 | 参数、HTTP、文件或响应错误 |
| 2 | 部分派发失败/未就绪，或有失败任务/读取错误 |
| 3 | 等待到期仍有任务运行 |
| 130 | 收到中断，后台任务不被取消 |

`result show.business` 原样展示服务端第七步的执行状态及判定。模型分数、阈值和状态保留在 `data.steps` 与 `business.model_scores`，不由 CLI 重新算分。评分成功仍可能无效或未达标；缺判定时报告未知，不能推定通过。

等待按轮次公平查询全部任务，最多4个并发读取；终态不再轮询，前几个长任务不占住后续查询。等待上限1小时，GET单次等待不超过30秒；HTTP传输等待35秒是单次请求故障边界，不改变模型执行超时。读取故障保留其他任务结果，不取消任务；下次直接以同一 ID 读取。POST 永不自动重试，超时/断开/响应解析失败标记 `outcome_unknown`，先查状态再处理。后组派发失败保留此前已取得的任务 ID 和未发送范围。

`attempt wait` 返回 `completion_scope=attempt`，不覆盖外部交付确认。默认请求 `view=status`，仅保留 id、workflow_id、ordinal、status、error、started_at、finished_at、completed 和单项 read_error，不读取题面、答案及评分正文；旧服务忽略视图时 CLI 仍投影这些字段。`attempt show` 或 `attempt wait --full` 可按需读取原有完整结果，HTTP 默认视图仍保留完整 result。服务端长轮询每秒查询一次，剩余预算不足1秒则只等待剩余时间；取消及时唤醒，不取消持久任务。无需正文时不使用 `--full`。

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
| remote-materials.test.ts | 注入 HTTP 与临时目录验证远程材料请求、同键找回、下载摘要、路径边界和中断清理；不连接服务器 |
| remote-answers.ts | 远程作答提交、start/run/status 和 request-key 恢复 |
| batches.ts | 本地批次清单创建、读取、固定分组及原子跳过记录，不保存业务状态 |
| failed-export.ts | 读取当前未达标判定与精确绑定的产物，按固定目录导出题目、作答及评分 |
| client.test.ts、commands.test.ts | 注入HTTP夹具验证本机API客户端、命令映射、等待与批量派发；不连接数据库、不调用模型 |

定向单元测试使用完整路径：

```sh
bun test ./cli/client.test.ts ./cli/commands.test.ts ./cli/remote-materials.test.ts
```

不要使用 `bun test cli`：Bun将它视为名称筛选，可能匹配其他目录的client测试。合成题目1流程验证命令契约，不能证明真实卷宗、正在运行的后端或Codex自主执行质量。操作Skill见 [SKILL.md](../skill/SKILL.md)。


## 选择脱敏模板

`library template list`及`library template show --template ID`读取提示词、workflow、digest；不要从旧笔记推断当前规则。`library job start --kind redact ... --template ID`按数据库模板选择实际流程；省略模板默认aliases/codex_plan，自动进入本机Agent消费池。默认沿用系统Agent设置并在入队冻结；也可成对提供`--agent-model 模型 --reasoning-effort 等级`，仅覆盖并冻结本次脱敏任务，不修改系统默认。Agent读取整包、维护私有固定虚构姓名表、保留法院名称并输出字段/结构块语义计划；程序计算偏移、校验并在现有事务保存。使用本次冻结执行预算，到限停止保留私有进度，不自动重试。显式mask或旧字段映射新任务会被拒绝；CLI本身不调用模型。

新计划在既有`codex-material-export-v1`上增加`template_id`和`template_digest`。单文件documents show返回structure及field_ranges，原页UTF-16编辑必须位于单个字段内，分册定位替换后正文且不切断表格/列表。export与import均校验模板摘要和结构；import保存新版本，不切换项目选版。无模板旧计划保留文本兼容，不能声称保留表格结构。

共用设置的新模板只支持codex_plan，每项仅配置provider=codex与prompt；旧字段映射模板不允许新保存。读取设置不改写历史任务或结果。

### 期次材料处理模式

`project settings apply`的`steps.author_question.material_processing_mode`仅支持`aliases`（默认Agent化名）和`original`（不脱敏）；历史`mask`不得重新保存为新流程；与旧`material_source_mode`同时提交时必须一致。配置仍经现有步骤API保存到数据库。`library job start --project <期次UUID>`把期次上下文交给服务器选择处理流程，不用提示词指示改流程；原文模式无需redact任务。CLI只调用API，不实现脱敏，也不把阶段文件当作已入库。模式、来源冻结与恢复边界见[材料库说明](../server/material-library/README.md#期次两种处理模式)。

## OFD与超限PDF上传前准备

显式本机文件操作：`bun run ai-distill library files prepare --manifest /绝对路径/原件清单.json --out /绝对路径/新输出目录`。清单仍为`{"files":[{"path":"原件.ofd","redaction_mode":"model"}]}`，相对路径以清单目录为基准。输出目录必须不存在；保留原件，生成PDF/分片、可供`library revision create --manifest`使用的清单和逐文件来源摘要。不自动上传或启动提取/脱敏；redaction_mode为兼容声明，不意味着运行脱敏。

OFD依赖需经授权显式执行`bun scripts/runtime/ofd/install.ts`安装；预处理不会自动安装。页数检查成功不证明视觉一致，须抽查转换页面。原OFD保留在源路径，上传清单使用转换件；来源审计只在本地provenance保存，当前数据库不新增OFD原件到PDF的来源字段。重复上传仍按版本与request-key契约处理，不得用新键盲重试。

### HTTP客户端维护边界

`client.ts`的`response()`负责地址/传输边界，`readJsonResponse()`统一JSON与multipart响应解析和安全错误，`download()`单独处理二进制。公共解析不能增加自动写重试、泄露非JSON正文或丢失`request_id`及`outcome_unknown`。CLI仍只是HTTP客户端，不在解析层计算业务状态或访问数据库。

## 本机状态、容量与手动建议

`queue show`读取本机队列及容量；`queue cancel --job UUID`请求取消本机记录。`workflow status`的steps.executions区分本机/其他执行端/未归属，业务成果仍为共享结果。容量429的local_queue_full表示明确未派发，CLI保留lane、上限、占用及请求数；不会自动重试POST。批量4/5/6的already_accepted计为已跳过，不触发新尝试。

`advice show --workflow UUID`读取建议；`advice generate --workflow UUID`手动派发。批量用`advice generate --project UUID --all`或`--ids UUID,...`，遇到容量不足或写入回执未知后停止后续派发，并保留已取得的ID。相同依据复用；下一次出题冻结有效建议。CLI仍仅是HTTP客户端，不直连PG或SQLite。功能结构、版本和恢复边界以[建议模块](../server/revision-advice/README.md)及[队列模块](../server/execution-queue/README.md)为准。

建议任务不属于原步骤attempt等待接口；以`advice show --workflow UUID`跟踪，批量结果使用`advice_attempt_ids`，不要将它们交给`attempt wait`。

## 豆包飞书交付

命令入口为`feishu config show/set`、`feishu table create`、`feishu sync`及`feishu sync-batch`；完整旗标以HELP为准。实现位于`cli/feishu.ts`与`commands.ts`，只调用本机HTTP API，不读取飞书App Secret、不直连数据库。HTTP契约及字段唯一来源见[飞书交付](../server/publishing/README.md#豆包飞书交付)。当前仅豆包启用，不能将其当作Work交付入口。

- 查询或更换该期默认表：`feishu config show/set`；set核对既有表字段后保存配置，不自动补传旧题。
- 一次性交付N题到新表：固定N个当前已达标、已归档的workflow ID；先运行`feishu table create`，记录返回的base_token/table_id，再运行`feishu sync-batch`显式传入这两个ID。只建一张表，不为每道题单独建表，不改变期次默认目标。
- 默认表已有具体ID时，单题`feishu sync`或批次可省略目标旗标；显式`--base-token`和`--table`必须成对提供。同一表内更新原记录；不同表分别记账。
- `sync-batch`只接受明确`--ids`，不提供`--all`。预先核对整批归属/达标/归档，再依次上传。`--out`须为不存在的新JSON文件，父目录须存在；发送前记录dispatching，逐题保存回执。complete表示全部成功；partial/退出码2保留succeeded、failed、in_progress、unknown及pending。
- 不自动重试。unknown或遗留dispatching先核对远端和服务端归档尝试中的feishu_deliveries；pending没有发送。显式补传时只指定需补传ID并用新的进度文件，不能把原批次未知请求当成未执行。
- 未指明目标的批次会先读取并固定期次默认具体表ID；尚只有按期名路由、没有具体表ID时，先明确创建/选择目标，不在批次中途自动改向。
- CLI先查后端能力标记；旧API返回404或未声明target_override时停止，不降级到可能忽略目标参数的旧同步接口。源码支持不等于服务已加载，重载仍须单独授权。

飞书写请求的CLI等待预算为180秒，普通请求仍为35秒；服务入口仅为飞书配置、建表和单题同步请求放宽到180秒空闲连接时限。远端HTTP本身仍受90秒截止控制；超时不是失败未写入的证明，CLI不会自动重发。

批量步骤执行返回 `already_archived` 表示该题已归档并被跳过，CLI 将其视为正常跳过；单题重复出题、作答、评分、判定或归档由服务端返回409，不会清空已有结果。

飞书批次结果中的`verified`、`verification_failed`、`verification_incomplete`分别统计程序核对通过、明确差异和未完成；具体差异见每题`receipt.verification`。旧API无verification的成功回执不算核对通过。

核对失败的HTTP502会再读同题归档安全回执；只有目标表一致、核对时间不早于本次派发时才采用差异详情，旧回执不冒记本次结果。读取失败或未知外部请求保留unknown，未派发项仍为pending，不自动重发。

## 排队与长等待诊断

`bun cli/index.ts queue diagnose --json`并行读取现有队列与监控API，报告有排队却无运行、出题/评分入队超过15分钟及异常worker快照。`elapsed_ms`是自入队的总时长，包含排队，不是模型生成时长；running心跳不重置此计时。只输出任务ID和安全状态，不读取正文，不取消、重派或重启。单worker快照无法证明所有消费者存活，告警须结合原attempt和日志定位。实现见`queue-diagnostics.ts`；查询失败直接报错，不返回健康。

## 可选材料整理

`library prepare start/list/show`调用材料库可选整理接口，`library job show/wait/cancel`沿用现有任务；确切参数以HELP为准。start必须明确提取任务或脱敏结果，可带项目上下文及本次Agent模型。只调用HTTP，不读取业务数据库、不自行调用模型。wait到期只停止等待，不取消或重派。

`project materials question`不接收整理结果、候选或文书筛选参数。建题时服务端按材料包、版本、来源摘要和项目匹配最近成功整理结果，并把它冻结进本题来源快照；未整理或整理失败时仍使用完整材料。出题Agent读取材料包总摘要、逐份摘要/标签、多组支持范围和本期已用方向+场景，最终决定并保存本题选择；作答与评分继续只读取完整题目快照。整理入口、迁移和数据边界见[材料库说明](../server/material-library/README.md#材料整理与使用范围)。
