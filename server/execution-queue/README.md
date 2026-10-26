# 每机执行队列

面向维护者。API与worker服务入口默认`EXECUTION_QUEUE_MODE=local`，启用每个运行目录独立的SQLite队列；显式`legacy`才保留旧消费者，用于受控升级。直接导入业务模块的测试/维护工具不自动切换进程模式。未知值拒绝启动。源码支持不等于业务环境已切换。切换前先完成047迁移和旧队列归属核对，不能仅修改环境变量。

## 文件与职责

| 文件 | 入口及职责 |
| --- | --- |
| `store.ts` | `LocalQueue`：本机身份、持久意图、原子领取/租约、取消、明确续跑代次、带摘要的调用结果；不连接PG、不执行业务。 |
| `runtime.ts` | `registerLocalJob`在原业务事务内登记归属；确认本机意图、恢复提交、取消补交；AsyncLocalStorage限制明确ID的领取；不推导法律业务规则。 |
| `worker.ts` | `runLocalQueueWorker`只消费本机队列，调用原出题/作答/评分/交付/材料/Skill/钩子/远程组合操作执行器；各lane共享同机跨进程槽位。 |
| `routes.ts` | `registerExecutionQueueRoutes`提供本机队列状态、指定旧任务认领及本机取消；由app挂载，不返回正文和结果检查点。 |
| `store.test.ts`、`runtime.test.ts` | 临时SQLite及SQL替身验证独立领取、取消、结果复用和中断；不是实体双机验收。 |

真实PostgreSQL/HTTP/材料路径隔离验证入口见`../../scripts/verification/verify-local-queue.ts`及其目录README。它使用专用临时数据库的完整迁移，不访问业务数据库或调用模型。

## 状态与数据流

API先在`<STORAGE_DIR>/runtime/queue.sqlite3`持久化pending_registration意图，再在原业务事务中写`execution_dispatches`归属；确认相同owner及generation已提交后转queued。云端steps/attempts继续作为业务状态与结果历史，不能据其waiting重建全库本地队列。派发复用原输入快照和业务防重锁。

worker仅原子领取本机queued或可恢复的result_pending_commit，原runNext的SQL限制为明确ID；旧的全库失租恢复在local模式关闭。Agent/API/internal/钩子/远程编排使用独立lane与同机进程槽位，Agent/API上限读取现有配置。服务器/api模式只消费API/internal/远程任务，不启用Agent及本地脚本钩子。执行事务结束后才调用模型，不长时间持有SQLite写锁。

外部调用由`runExternalCall`将返回值序列化到私有SQLite检查点并校验摘要。提交网络错误且返回值完整时保留result_pending_commit，重放原业务校验与发布路径时复用返回值；同ID同代同调用键不重复收费调用。结果未知则needs_review，不自动重放。收到云端成功但本机确认丢失时，只对账补记committed。已超过原材料预算或输入失效仍按原校验拒绝，不能借恢复延长模型预算。显式钩子重试由原入口校验副作用/检查点，再递增generation；回滚的代次不激活。

本机取消先持久化并传播信号，随后同步云端。断网保留cancel_synced=0，恢复后只补交取消；取消请求不等于远端调用已停止。另一台电脑不能领取或回收本机任务。共享业务冲突及同一供应商账号限额仍可能跨机影响，队列独立不承诺业务库或上游服务完全离线。

047迁移给五类业务任务登记归属并添加UPDATE保护。PG连接的`application_name`为本机执行身份；启动时实际核对，不从配置值推定有效。旧消费者更新已归属任务会被拒绝；明确业务失效/取消仍可通知。该身份是受信任程序的归属约束，不是数据库认证/权限系统，不能用它代替对外鉴权。

SQLite使用WAL/FULL同步及短事务，目录0700、文件0600；不能放在网络共享盘或同步活动数据库文件。设备标记位于用户本机`.local/share/ai-distill/device-id`，运行目录身份与设备标记绑定，复制代码不能复制活动队列；发现不同设备标记时拒绝领取，不自动迁移。默认一机一个运行目录；多副本须显式共用同一目录才能共享槽位。

## HTTP契约

- `GET /api/system/execution-queue`：本机模式、executor_id和轻量队列状态；不返回结果BLOB、租约令牌或正文。
- `POST /api/system/execution-queue/adopt`：`{jobs:[{id,kind}]}`，kind为step/skill/library/hook/remote；1–100个明确的旧waiting/queued任务。已属于其他执行器、正在运行或同步钩子拒绝。route/lane由业务记录解析，不接受客户端伪造。
- `POST /api/system/execution-queue/:id/cancel`：只取消本机记录；返回cancel_requested与cloud_synced。其他机请求应通过明确业务取消入口通知，不能冒充本机已停止。
- `POST /api/system/execution-queue/:id/reconcile-failed`：仅供本机故障对账，提交 `{failure_event_id,failure_instance_id}`。要求本机队列任务已停止且处于`needs_review`、存在未决调用、指定worker实例的结构化日志含匹配的`attempt.failed`且没有后续成功事件，同时PG中的归属、代次、最新attempt和step仍匹配并处于`running`；全部通过后在一个事务内将attempt和step结算为`failed`，不重放调用。保留供应商的可重试标记，但设置本次`retryable=false`以阻止隐式重试；日志扫描受50文件/20 MiB限制，超限或证据不完整即拒绝。
- `GET /api/monitor`：local_execution_queue提供本机实际状态；活动任务过滤为本机正在执行，待登记/同步/核实单列；全局业务列表仍共享，不按本机队列隐藏其他机成果。

CLI继续调用原HTTP派发入口，不直连SQLite或PG。本机队列管理CLI见下方容量与状态投影章节。

## 切换与恢复边界

先盘点旧waiting/queued与running。047可在未归属旧任务运行时定向应用：归属为空时触发器保留原行为，DDL锁超时则整笔回滚。只应用047，不盲跑业务库全部未登记迁移。本机API先启用local，新派发登记归属；旧worker可继续收尾未归属任务，数据库保护拒绝其领取新归属任务。本机新worker与旧worker使用同一运行目录及现有槽位，历史队列归零后停止旧worker。另一台同样启用；按明确ID分配未开始的旧任务，不能每台复制全部。模型/阈值/规则、题目快照、成绩和历史不随切换改变。

业务环境尚未切换时，新旧代码的兼容测试不能替代实际双机验收。存在未同步结果或取消时不回退旧消费者，不删除SQLite“清空重来”。应先停止新派发、备份本机队列并按同ID对账；没有明确归属的旧任务保持未认领，而非自动猜测机器。


## 已知失败与对账

出题、作答、评分处理器在结算失败之前，将安全终态（failed/skipped、原因、结构化结果）写入本机当前代次检查点。数据库不可用时保留result_pending_commit；恢复只进入原处理器的失败结算，不再执行模型、输入准备或同步钩子，也不重置当前步骤为running。沿用版本、最新尝试及多模型汇总检查。损坏检查点进入needs_review；没有业务终态的started/rejected调用不能自动重放。新代次不读取旧代次检查点。云端已成功或失败时补记本机终态。

worker在启动及每轮后台对账开始时恢复本机已死亡PID遗留的running记录；仍存活的PID保持原样，未知调用转needs_review而非重新执行。PID存活检查不证明该PID未被系统复用，不能据此声称所有孤儿均能恢复。候选匹配使用ID索引但仍保留完整亲和性筛选和原子领取，不改变领取窗口与公平性。

worker对账为单飞后台轮次，不作为各通道领取的前置等待；登记、取消、终态各轮最多20项并轮转。单项失败保留原状态并继续其他项，轮次结束等待5秒。状态读取的驱动超时15秒，沿用连接池15秒连接等待；取消事务另设10秒SQL/2秒锁等待，失败连接丢弃。超时不证明业务写入未发生，仍按原ID对账，不据此重跑模型。

取消轮次先用一次有界批量查询探测最多20个ID的登记。未登记项继续保留`cancel_requested=1/cancel_synced=0`，不逐条开启空事务，也不将未知登记冒记为已同步；已登记项仍进入原事务重新核对owner和业务终态。晚提交的登记由后续轮次处理，单项失败不阻断同批其他项。

worker.test.ts使用临时SQLite、SQL替身和随机端口本机HTTP服务验证慢对账隔离及状态响应，不代表真实PG断网、现有服务部署或模型验收。三个业务jobs测试显式使用legacy替身模式；local恢复用例自行创建临时队列，避免继承工作台配置。

## 领取范围与材料失败

`WORKER_WORKFLOW_IDS`传入local消费器，在SQLite原子领取前通过业务元数据过滤；仅领取所列工作流的出题、作答、评分和交付，不触碰其余已排队记录或库级任务。mode、execution_target与API任务的本地脚本亲和性同时核对，不能把启动提示当作范围已生效。

材料库已知失败也在当前本机代次保存安全终态（failed/cancelled、原因、原租约），数据库恢复后只按原任务/租约补结算，不重新领取、不重新读取原件、不重跑提取/脱敏、不延长预算。未命中原租约时不覆盖新的执行者；损坏或无法确认的记录继续待核实。检查点保留在私有SQLite，不通过监控API返回。

## 容量与步骤状态投影

`store.reserveIntents()`在SQLite立即事务内为整组新任务预留待领取名额；多模型按模型attempt计数，混合通道任一不足时整组不派发。运行上限与待领取上限分别为N，不相加成一个上限。新pending_registration预留计入waiting；历史无预留的待登记意图保留，不自动挤占名额。登记确认、取消和显式续跑沿用同一容量检查。

上限读取现有配置；仍存活的消费者已登记槽位上限优先，保存设置尚未重启时不按新值虚增队列。API返回429/code=local_queue_full/dispatched=false并带lane/limit/waiting/requested；批量逐题返回capacity_exceeded。只有同连接ROLLBACK已确认且PG归属复查确定未提交时，释放该事务预留；回执不明保留意图和容量，不按超时自动删除。

`status.ts`将活动尝试的归属元信息投影到`steps[].executions`：本机用SQLite的queued/running/needs_review/result_pending_commit等状态，他机明确标注other_executor，缺记录或代次不同显示待核实；读取不改云端结果或自动重派。多模型保留全部活动尝试，不只取最新一条。本机步骤运行/排队汇总只计本机活动；全局成功结果继续共享。

CLI已有`queue show`和`queue cancel --job UUID`，仅调用同一HTTP入口；旧任务认领和有日志证据的失败对账仍使用上述HTTP契约。`advice`为050启用的独立手动建议任务，不是步骤ordinal，使用同一Agent容量与归属保护。

他机活动仅能读取共享尝试标记，executions.source=shared_attempt并明确待核实，本机不据此声称供应商正在生成；source=local_queue才来自所属SQLite。取消手动建议将业务状态记skipped并保留取消原因，不清除原题或建议历史。

local步骤投影存在但活动尝试为空、共享step仍为running时，页面显示“共享状态待核实”；不按残留字段冒记本机运行，也不自动改成成功/失败。

## 长期运行的周期读取

worker监控和`/api/monitor`只投影活动、待登记、待同步及待核实任务，不将已结束历史明细周期性搬入内存。材料库历史状态数量由SQLite聚合，保留原统计语义；显式`queue show`仍可读取完整本机队列。

登记、取消和结果对账每类每轮最多20条，按`created_at,id`稳定键翻页，读到末尾后回到开头；长期未决前页不阻塞后页。恢复仅读取running。SQLite启动时补充状态/顺序、kind/状态及未同步取消索引，兼容既有队列，不删除历史与未知调用记录；不涉及PG迁移。

这减少历史增长引起的扫描和JS对象分配，不代表已证明网络延迟或供应商断流的根因。取消检查仍按连接池合并，任务心跳仍遵守原有间隔和同一任务不重叠规则。

未开始的评分如需取消后重新显式派发，使用服务端[未领取评分取消契约](../README.md#未领取评分的显式取消)。此入口不迁移归属、不处理running或未知调用；取消本机SQLite仍用原queue取消接口。

旧步骤9只保留人工已脱敏声明发布。历史字段映射意图即使仍归属本机，也由原执行器以field_mapping_removed终结，不调用API或Agent；材料库Agent化名任务不受此删除影响。
