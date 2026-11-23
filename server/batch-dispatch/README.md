# 本机批次调度

工作台、CLI 和 AI 共用本机 HTTP API。AI 或操作人先把筛选结果导成清单，例如只选第七期中已确认人名的飞书行。清单应写入准确的期次、材料包版本、题目或目标行 ID，人员写入对应分项的 `owner`。程序只处理提交的分项；飞书账号筛选、提取材料和生成清单由上游负责。服务保存启动时的清单和后续状态，关闭网页或结束 AI 会话后，已有 Worker 可以继续办理。

## 生成清单

一份清单可包含四类不同的分项。每项需要本批唯一的 `id`、`type` 和 `input.project_id`。依赖用分项 ID 指向上游，同一材料结果可供多个分项使用。已有合格的上游结果可直接填业务 ID 单独启动。默认估时是脱敏 16、整理 6、出题 17、交付 1 分钟，各项可覆盖 `expected_minutes` 与 `weight`（默认 1）。

| type | 输入及实际办理 |
| --- | --- |
| redact | 指定 package_id、revision_id、extraction_job_id。复用同来源的有效脱敏结果；明确重做时填 previous_job_id，受原业务续作规则约束。 |
| prepare | 指定 package_id、revision_id，从 redaction_from、redaction_id、extraction_job_id 中选一个。force 可要求重新整理。 |
| author | 已有题填 workflow_id，按题目冻结来源出题。新建题填 load_package_id 或 link_id + link_version，以及 title；用 material_from 指向脱敏或整理，也可以直接指定 redaction_id 或原文 revision_id。新建题按期次材料使用规则加载。跨期复用填 original_workflow_id 和新 direction。对已加载关系显式设置 select_source 可按锁版本切换至上游新来源。已创建题目的来源须匹配，发生冲突会留下失败原因。 |
| deliver | mode=draft 可接 author_from，或直接指定 workflow_id 和 author_attempt_id。mode=archived 用于已有有效归档，明确指定题与出题尝试。每个目的地写明 base_token、table_id。草稿可指定本题已有的 record_id，远端状态和身份须符合已有交付规则。成功需要实际同步回读及记录 ID。 |

材料分项可指定 model 与 reasoning_effort；出题还可指定 provider（codex / agy）。省略时按相应业务配置解析。批次使用本机 Agent 执行脱敏、整理与出题，交付占独立并发。字段全集及值约束见 [manifest.ts](manifest.ts)。

以下为结构示例。运行前须替换成业务系统中的真实 ID 和已授权目的地。

```json
{
  "version": 1,
  "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "limits": {"agent": 14, "waiting": 14, "delivery": 1},
  "tasks": [
    {"id":"m01-r","type":"redact","owner":"负责人甲","input":{"project_id":"11111111-1111-4111-8111-111111111111","package_id":"22222222-2222-4222-8222-222222222222","revision_id":"33333333-3333-4333-8333-333333333333","extraction_job_id":"44444444-4444-4444-8444-444444444444"}},
    {"id":"m01-p","type":"prepare","owner":"负责人甲","input":{"project_id":"11111111-1111-4111-8111-111111111111","package_id":"22222222-2222-4222-8222-222222222222","revision_id":"33333333-3333-4333-8333-333333333333","redaction_from":"m01-r"}},
    {"id":"q01-a","type":"author","owner":"负责人甲","input":{"project_id":"11111111-1111-4111-8111-111111111111","load_package_id":"22222222-2222-4222-8222-222222222222","material_from":"m01-p","title":"本包出题方向"}},
    {"id":"q01-d","type":"deliver","owner":"负责人甲","input":{"project_id":"11111111-1111-4111-8111-111111111111","author_from":"q01-a","mode":"draft","base_token":"examplebase000001","table_id":"tblExample01"}}
  ]
}
```

## 启动、查看和停止

工作台在“任务监控 → 批次调度”支持导入 JSON、预览、启动、查人和任务状态、停止续派。CLI 的 preview/start 接受 `--file` 或 `--url`，URL 由客户端在每次命令执行时读取一次。要求预览与启动字节一致时使用同一本地文件。两种入口均调用下表 API。

| 本机路由（前缀 /api/dispatch-batches） | 作用 |
| --- | --- |
| POST /preview、POST 根路径 | 校验字段、引用和现有业务归属；后者持久化完整清单。同 ID 同清单重放返回现状，内容有变返回冲突。 |
| GET 根路径、GET /:id | 本机批次列表、逐项状态。详情包括 owner、type、depends_on、job_id、request_id、时间、result 与 error。 |
| GET /:id?summary=1 或 ?state=failed | 按状态和阶段汇总（counts、by_stage），或查指定状态的明细。 |
| GET /:id/events?after=N | 读取指定游标以后的任务和执行队列事件，每次最多 500 条。保存 next 下次续读。当前业务结果以详情为准。 |
| PUT /:id/limits、POST /:id/stop | 活动批次替换容量配置；停止续派后，已派发的任务继续收尾。 |

```sh
bun run ai-distill dispatch preview --file scope.json
bun run ai-distill dispatch start --file scope.json
bun run ai-distill dispatch show --batch <批次UUID> --summary
bun run ai-distill dispatch show --batch <批次UUID> --state blocked
bun run ai-distill dispatch events --batch <批次UUID> --after 0
bun run ai-distill dispatch stop --batch <批次UUID>
```

`waiting_dependency` 表示等待指定上游，`ready` 可派发，`queued` 已入队，`running` 已被执行器领取。业务提交或本机队列结束后，调度器按这次业务 ID 读取匹配产物，再记 `succeeded` 并开放后继。交付需要飞书回执。可确定失败记 `failed`；回执无法确认记 `unknown`；上游失败或待核的后继记 `blocked`，其他分支继续。排查时用任务 ID 读详情、按 job_id 查原业务记录。外部交付中断后需要核对原目标，不会自动再发一次。终态批次分别为 succeeded、incomplete、stopped。

## 调度与持久化

- 本机 local 模式、未限定工作流的 all/local Worker 内运行。API 进程接收清单，已有 Worker 领取及提交事务后唤醒调度器，入队通知唤醒空闲消费者。1 秒一次的本机检查用来发现新批次和恢复漏掉的通知。
- Agent 槽与本机其他业务共享。批次有效运行上限为本批上限与 Worker 配置两者的较小值，省略则跟随 Worker。等待上限默认同批次运行上限，同时受系统队列剩余空间约束。运行中调低上限可让在途任务收尾，领取新项时按新上限执行。独立交付池的进程上限由 BATCH_DELIVERY_CONCURRENCY 设置，默认 1。
- 对每个阶段汇总剩余任务的“权重 × 预计剩余分钟”。按阶段工作量占比乘有效槽位，再减已占名额，优先补缺口最大的可运行阶段；同阶段优先较高权重和较早就绪的任务。只有上游产物已核实的分项才可参与。材料不足或只剩串行依赖时，空闲槽位属于正常情况。
- [store.ts](store.ts) 在本机 runtime/queue.sqlite3 保存清单、请求标识、事件、限制及回执。[scheduler.ts](scheduler.ts) 处理状态转换和补位；[worker.ts](worker.ts) 接入现有 Worker；[backend.ts](backend.ts) 复用业务入口和业务库版本核对；[routes.ts](routes.ts) 对外提供统一读写入口。单机只选一个调度者，业务任务继续使用既有领取与租约。
- [scheduler.test.ts](scheduler.test.ts) 使用独立 SQLite 和合成业务检查状态、容量、接续与恢复；[postgres.test.ts](postgres.test.ts) 使用专用临时 PostgreSQL、HTTP、CLI 和业务事务核验来源。隔离集成使用合成模型结果与交付回执；生产模型耗时和真实飞书送达须凭实际批次记录确认。
