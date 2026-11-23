# 本机与远程工作流 CLI

现有 Hono HTTP API 的命令行客户端与受限本地文件工具。Agent 默认直接调用本机 `http://127.0.0.1:3700` API；用户明确要求命令行时使用本 CLI。任何命令均不直连 PostgreSQL 或 SQLite 改写状态、不内置第二套评分/达标算法。

## 1. 快速查询与输出契约

```sh
# 全局概览或按命令前缀精确查参数白名单（推荐 Agent 按前缀查询，节省上下文）
bun run ai-distill --help
bun run ai-distill library --help
bun run ai-distill project --help
bun run ai-distill workflow --help
bun run ai-distill feishu --help
bun run ai-distill queue --help
```

- **公共旗标**：所有命令支持 `--json`；本机命令支持 `--api http://127.0.0.1:3700`（或环境变量 `AI_DISTILL_API_URL`，仅限本机回环地址、禁用重定向）。未知或重复旗标直接报错拦截。
- **JSON 信封与退出码**：成功输出 `{ "outcome": "complete" | "partial" | "waiting", "data": ... }`（`library job start` 同时保留顶层任务字段与 `outcome`/`data`）；错误写 `stderr` `{ "outcome": "error", "error": { "kind", "message", "http_status"?, "request_id"?, "outcome_unknown"? } }`。
  - `0`：查询成功、派发已受理或等待到终态（**不代表题目业务达标或飞书已验证**）
  - `1`：参数、文件或 HTTP/网络错误（写请求绝不自动重试；`outcome_unknown=true` 时先查状态）
  - `2`：部分派发未就绪/容量满，或存在失败任务/复核未通过
  - `3`：等待预算到期仍有任务运行（后台任务继续执行，不取消）
  - `130`：`SIGINT`/`SIGTERM` 中断等待（后台任务不取消）
- **下载安全**：所有 `--out` 下载/导出命令要求父目录已存在且目标文件/目录**不存在**（0600 独占创建，绝不覆盖）。

## 2. 项目、设置、规则与 Skill

- **项目与期次**：`project list`、`project show --project UUID [--workflow-page N --workflow-page-size N]`、`project create`（默认 `library_v1`，旧目录显式 `--material-backend legacy --material-root`）、`project update`、`project phase-update`、`project delete --project UUID --confirm-name 精确全名`、`project-group list|phases|rename|archive|restore`。
- **项目配置（`project settings show | apply --project UUID --file JSON`）**：支持按顺序写入 `codex`（`null` 恢复系统默认）、`models`（`[{model_id, minimum_score}]`）、`steps`（`author_question`/`model_answer`/`independent_score`/`accept_or_revise`，仅 4/6 支持 `null` 恢复默认，7 用 `{}` 恢复逐模型上限）、`answer_generation_policy`、`answer_tools`；中途失败保留前序已生效项并返回 `applied`/`failed`/`remaining`。
- **规则文件与项目 Skill**：`rules list`、`rules file --path`、`rules update --project UUID --path materials/xxx.md --file 本地文本 [--expected-sha256 SHA|null]`、`rules delete --expected-sha256 SHA`；`project skill list|generate|adopt`。
- **系统并发与 Agent 全局配置**：`system concurrency show | update --file JSON`、`agent config show | update --file JSON`、`agent test`。

## 3. 全局材料库、期次加载与分页

1. **原子提取入库与版本**：`library import --name 名称 --request-key UUID --manifest JSON [--pdf-provider glm-ocr|mineru-api|mineru-cli] [--preserve-images]`（提取全部成功才生成正式包/版本；`manifest` 为 `{"files":[{"path":"...","redaction_mode":"model"|"declared_redacted","image_review_required"?:true}]}`）；已有包更新用 `library revision create --package UUID --version N ...`；均用 `library job wait --job UUID` 等待终态。
2. **提取与脱敏任务**：`library job start --revision UUID --kind intake|extract|redact --target local|server --request-key UUID [--project 期次UUID] [--extraction-job UUID] [--agent-model 模型 --reasoning-effort 等级]`。`aliases` 模式走本机 Agent 化名，`original` 期次无需 `redact`。
3. **期次候选、加载与建题**：`project material candidates` → `project materials load --project UUID --package UUID (--redaction UUID | --revision UUID)` → `project materials question --project UUID --link UUID --version N (--redaction UUID | --revision UUID) --title 名称 --request-key UUID [...]`。跨期使用记录用 `project material uses` / `use events` / `use update`。
4. **搜索批处理**：`library batch plan --kind intake|extract|redact|prepare (--project-query 简称 | --project UUID | --q 词) [...] --out 清单.json`（全分页扫描并以 **AND** 冻结范围）→ `library batch run --file 清单.json`（容量不足或未知写入自动停止，同文件可幂等续跑）。
5. **Codex 本地材料计划导出/导入**：`library documents export --plan JSON --out 新目录` 校验原文摘要并机械生成分册预览；`library documents import --plan JSON --request-key UUID` 正式入库脱敏结果。
6. **分页与轻量参数**：`library package list`（默认 30，按 `total_count` 翻页）、`library imports list`（默认 50）、`library package revisions`、`library prepare list [--summary-only]`（默认 20，`--summary-only` 省去完整 JSONB）、`library redaction show [--metadata-only]`、`project materials list`、`project material uses/events`、`question list`（`--page/--limit`，1–1000）、`material-package list`、`result list`（默认 100，最大 500）、`export list` 均支持服务端分页。

## OFD与超限PDF上传前准备

上传或派发提取前若含 `DOC`/`WPS`/`OFD` 或超页数/大小上限 PDF，先执行纯本地转换切割（不写数据库、不调模型，OFD 需已授权安装转换依赖，转换件须人工抽查版面）：

```sh
bun run ai-distill library files prepare --manifest /绝对路径/原件清单.json --out /绝对路径/新输出目录 --json
```

成功后使用输出目录下的 `manifest.json` 执行 `library import` 或 `library revision create`；任一文件失败写 `failed.json` 且不生成 `manifest.json`。

## 材料整理

- **启动与续作**：`library prepare start --revision UUID (--redaction UUID | --extraction-job UUID) --request-key UUID [--project UUID] [--agent-model 模型 --reasoning-effort 等级 | --web deepseek|gemini [--web-thinking on|off] [--web-model-label 标签]] [--execution-timeout 30m] [--force]`；失败/取消任务显式恢复用 `library prepare resume --job UUID --request-key UUID`。
- **查询与诊断**：`library prepare list --package UUID [--revision UUID] [--redaction UUID] [--project UUID] [--page N --page-size N] [--summary-only]`；`library prepare show --preparation UUID [--content]`；`library prepare diagnose --job UUID`（仅返回阶段、停止原因与安全计数，不含正文）。
- **建题绑定**：`project materials question` 由服务端按包、版本、来源摘要与项目自动匹配冻结最近成功整理结果（对出题可见、对作答/评分及材料 DOCX 排除 `hidden` 文书）；无整理结果不阻断建题。

## 4. 步骤派发、网页通道、离线作业台与远程执行

- **唯一派发与等待流**：`workflow status --project UUID (--ids ... | --all)` → `step dispatch STEP_KEY --project UUID (--ids ... | --all)` → `attempt wait --ids UUID,... [--timeout 1h]`（默认 `view=status`，多模型须传入全部返回的 `attempt_ids`）→ `question show --workflow UUID [--status]` 或 `result show --workflow UUID`。
  - `step dispatch author_question` 支持单次覆盖 `--provider codex|agy --model 模型 --reasoning-effort 等级`，或改走网页通道 `--web deepseek|gemini [--web-thinking on|off] [--web-model-label 标签]`。
- **网页 Agent 通道（`web`）**：独立 6 槽位（需 064 迁移），仅支持 `library prepare start --web` 与 `step dispatch author_question --web`；管理命令：`web status`、`web doctor`、`web login --provider deepseek|gemini`、`web close`。
- **离线作业台（`offline`）**：不自动驱动浏览器，适合人工在网页端交互：`offline export --stage redact|prepare|author --out <目录> [--count N] [--web deepseek|gemini] [--project UUID] [--ids UUID,...]` 导出每任务 zip 与 `对账台.md`；人工将回复放入 `reply/reply-1.md`（续写 `reply-2.md`...）后运行 `offline import --out <目录>` 校验入库（未通过自动生成下一轮修正 zip）；`offline status --out <目录>` 查看汇总。
- **本地批次与复核导出**：`batch create|show|skip` 管理本地固定范围 JSON 清单；`export failed --project UUID (--ids ... | --all)` 与 `export review --project UUID --ids ...` 导出题目/作答/评分至 `assets/未达标题目/`；`siriser download`、`workflow material-docx generate`、`workflow material-image-docx download`、`workflow archive-xlsx download` 处理专项产物。
- **远程执行（`remote`）**：仅用于旧材料工作流（`remote material run|start|status|sync`）与无钩子服务器作答（`remote answer run|start|status`），须先配置 SSH 本地回环隧道与 `.env` 的 `REMOTE_MATERIAL_API_URL` / `REMOTE_MATERIAL_TOKEN`（见 [REMOTE.md](../skill/REMOTE.md)）。

## 显式恢复与交付确认

先通过 `question show --workflow UUID --status`、`workflow hooks show`、`workflow attempts --workflow UUID --ordinal N`、`queue show [--history]` 或 `queue diagnose` 核实原对象状态，再执行显式恢复（不自动重调模型）：

- **出题检查点恢复**：`workflow authoring restore --workflow UUID --attempt UUID`
- **题目设计/开头修订/撤回归档/软删恢复**：`workflow design update`、`workflow opening revise --workflow UUID --file JSON`、`workflow archive withdraw --workflow UUID`、`workflow restore-deleted --project UUID --deleted-after ISO --expected-count N`
- **脱敏复核**：`library redaction revalidate --redaction UUID`（`valid` 与 `usable_for_question` 同为 `true` 才返回 `complete`）
- **钩子恢复**：新后置增强用 `hook retry --hook UUID [--acknowledge-side-effects]`；旧主尝试钩子失败用 `attempt resume-hooks --attempt UUID [--acknowledge-side-effects]`
- **手动返修建议**：`advice generate (--workflow UUID | --project UUID (--ids ... | --all))` 生成建议，用 `advice show --workflow UUID` 跟踪（不传给 `attempt wait`）
- **本机队列对账与认领**：`queue cancel --job UUID`、`queue adopt --file JSON`（`{"jobs":[{"id":"UUID","kind":"step"}]}`）、`queue abandon-job --job UUID --acknowledge-unknown-result`（解锁过租材料任务；原子入库专用兼容 `queue abandon-import`）、`queue reconcile-failed --job UUID --event UUID --instance UUID`
- **归档与飞书回执核对**：`attempt wait` 仅代表本地归档尝试结束；豆包飞书须用 `workflow delivery show --workflow UUID` 核对目标表回执 `status=succeeded` 且 `verification.status=passed`。

## 豆包飞书交付

仅豆包项目启用（需服务端加载对应能力标记；安装 `soffice` 方可转图像版 PDF）：

```sh
# 配置/建表
bun run ai-distill feishu config show --project <PROJECT_UUID> --json
bun run ai-distill feishu config set --project <PROJECT_UUID> [--base-token <BASE> --table <TABLE>] [--attachment-format docx|pdf] --json
bun run ai-distill feishu table create --project <PROJECT_UUID> --name <新表名> [--base-token <BASE>] --json

# 草稿同步（步骤4成功且未归档，表内标“未完成”；支持合册PDF/DOCX、开头修订版或精确替换旧rec记录）
bun run ai-distill feishu draft-sync --workflow <WORKFLOW_UUID> [--base-token <BASE> --table <TABLE>] [--revision-attempt <UUID> | --replace-record-id <recID>] [--attachment-format pdf --combined-material] --json
bun run ai-distill feishu draft-sync-batch --project <PROJECT_UUID> --ids <UUID1,UUID2> --out .storage/draft-sync.json [--base-token <BASE> --table <TABLE>] [--attachment-format pdf --combined-material] --json

# 正式归档补传（已达标且步骤8归档成功，表内标“已完成”）
bun run ai-distill feishu sync --workflow <WORKFLOW_UUID> [--base-token <BASE> --table <TABLE>] [--attachment-format pdf --combined-material] --json
bun run ai-distill feishu sync-batch --project <PROJECT_UUID> --ids <UUID1,UUID2> --out .storage/sync.json [--base-token <BASE> --table <TABLE>] [--attachment-format pdf --combined-material] --json

# 脱离业务API的本地快照草稿交付（仅用户明确要求时使用；不自动合并多个DOCX）
bun run ai-distill feishu local-sync --manifest <清单.json> --out <新回执.json> --base-token <BASE> --table <TABLE> --json
```

批次命令仅接受明确 `--ids`（无 `--all`），发送前落盘 `dispatching`，遇到 `failed` / `in_progress` / `unknown` 立即停止并保留剩余 `pending`，**绝不自动重试**（合册 DOCX 草稿异常时仅做一次只读远端字段/token 对账恢复）。补传前必须先核实远端记录与 `workflow delivery show` 回执。

## 5. 定向测试验证

```sh
bun test ./cli/client.test.ts ./cli/commands.test.ts ./cli/library-batch.test.ts ./cli/remote-materials.test.ts ./cli/remote-answers.test.ts
```

（注意使用 `./cli/...` 完整路径，不要运行 `bun test cli` 以免按子串误匹配其他目录。）

批次清单入口为 `dispatch`，支持本地文件、线上 JSON、状态摘要、增量事件、调整容量和停止续派。参数与结构见[批次调度](../server/batch-dispatch/README.md)。
