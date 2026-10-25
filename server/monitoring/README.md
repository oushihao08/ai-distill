<!-- 文件职责：说明 worker 与本机资源监控的采集和报告接口。 -->
# 本地 worker 监控

采样本机内存、进程、数据库等待／运行任务及心跳，向 API 提供安全本地快照并控制派发；监控接口另返回正在运行的项目步骤和独立材料库队列，不把全局库任务重复归属到项目。

## 文件职责

| 文件 | 说明 |
| --- | --- |
| `resources.ts` | 本地资源采样与建议：读取 macOS／Windows 内存和登记进程数据，将未知值显式表达并计算派发建议。 |
| `worker-monitor.ts` | worker 安全监控：采集任务与资源心跳、写入共享快照并据内存阈值控制新任务派发；查询活动工作流尝试与材料库队列，并只投影允许的进度字段。 |

## 数据流与依赖

worker-monitor.ts 在 worker 生命周期采样并写共享存储快照；resources.ts 按平台读取资源与未知值；API 读取快照并查询运行中尝试的安全摘要和 `library_jobs` 汇总；前端 WorkerMonitor 展示全局材料库的排队/运行计数及有限安全进度。旧数据库尚无材料库迁移时，队列状态显示 unavailable，不影响 legacy worker 派发。

## 维护边界

活动步骤按冻结provider识别Codex作答/API评分；本机活动attempt ID在SQL LIMIT之前过滤，空本机集合不回退全局。共享worker快照仍是单实例投影，多worker聚合尚未改造，安全重载不能只依赖单个快照。

内存不足暂停新领取，不能当成强制停止正常任务；未知采样值显式展示。API 与 worker 须共用存储路径。子进程、真实登录额度和完整故障恢复不因快照存在就算验收。

本模块的 `*.test.ts` 保留既有验证意图；存在测试文件不表示本次运行。执行与授权遵循 [项目规则](../../AGENTS.md)。

监控将数据库任务统计与本机内存采样分开刷新。派发只等待内存采样；任务统计通过`db.ts`的`readStatusRows()`读取，在只读事务内设置2秒 PostgreSQL `statement_timeout`，BEGIN/SET/SELECT/COMMIT及回滚另有逐次3秒驱动读超时。失败连接销毁；驱动读超时不继续排入回滚，防止未结束查询回到池中。统计失败时任务状态显示未知，不改变内存派发阈值。停止时等待在途采样与查询结束，再写入最终停止状态；迟到的任务查询结果不会覆盖停止快照。3秒限制不是整个轮次上限；连接获取另受现有连接池15秒上限控制。

## 判断边界与已知投影限制

- 真正的`beforeDispatch()`只按已知低内存暂停新领取，内存unknown时允许继续；`adviseDispatch()`给出的认证、额度或任务数建议不直接成为派发闸门。不能把advice=unknown误读为任务停止。
- macOS系统内存继续使用`memory_pressure -Q`，进程RSS使用`ps`。Windows系统可用物理内存使用`node:os`的`totalmem()`／`freemem()`，进程工作集使用系统自带Windows PowerShell的`Get-Process -Id`批量读取；禁用profile和交互、隐藏窗口、3秒超时。两平台均将可用比例向下取整为整数百分比，再据该百分比估算字节数；采样方法分别为`macos_memory_pressure_percentage`和`windows_available_physical_memory`，API同时接受两种快照。
- 进程采样只包含当前worker和登记Agent PID，不扫描所有系统进程或读取进程参数/环境；已退出、无权限或重复返回的PID保持unknown，不影响其他PID及系统内存。Windows失败时不调用Unix命令兜底；其他系统的系统内存仍为unknown。
- 共享`.worker-monitor.json`是同存储位置最后写入的worker快照，不是多worker合并清单。30秒以上旧心跳（或未来偏移超过5秒）投影为stale；stale不能证明供应商任务已经结束，也不能据此自动重派。
- `readActiveWorkflowTasks()`最多返回500条运行尝试；channel按冻结provider区分Codex作答与API评分，未知provider保持unknown；明细不替代本机队列容量。
- 全局库计数是任务历史状态数，非去重材料包数；活动明细最多100条，计数可能大于明细长度。安全progress只含白名单计数，是本地执行器阶段信息，不是供应商token/页生成进度。
- 项目任务统计查询不含library_jobs，后者通过独立队列摘要展示。快照中的auth/quota通常为unknown，不进行实时登录/额度探针。

`resources.test.ts`通过注入命令输出核对解析/PID/建议；`worker-monitor.test.ts`使用临时文件、注入数据库与采样检查共享写入、低内存/未知、统计超时、停止等待和投影。它们不证明真实OS资源、供应商进度或多机监控。

本模块local队列模式的派发归属、指定ID领取、取消及恢复接入共享[执行队列](../execution-queue/README.md)；业务输入/结果契约保留，默认兼容模式不代表业务环境已切换。

更改资源采样与快照校验后，API与worker都需要加载新代码；只重启worker而API仍运行旧校验器，会拒绝Windows已知内存快照。按根规则取得运行授权，并在现有任务安全收尾后通过原启动入口重启；不以改写运行中快照代替代码生效。源码支持及本机只读采样不等于现有服务已重启验收。

local模式的任务计数直接读取所属SQLite queued/running，不再周期性向PG发BEGIN/SET/SELECT/COMMIT获取全局占用；启动先读取本机任务再发布首帧。legacy仍使用原有有界PG读取。步骤活动明细的channel已按冻结provider区分Codex作答/API评分，不能只按ordinal猜通道。worker监控文件仍是最后写入快照，不能代替实体多机资源验收。

长期运行边界：周期采样只读SQLite活动任务；HTTP监控额外列出待登记/同步/核实记录，终态明细不随每次刷新返回。材料库终态数量仍由本机SQLite按状态聚合，不改为活动行计数。显式队列管理接口保留历史。具体分页和索引见[本机队列说明](../execution-queue/README.md#长期运行的周期读取)。

### HTTP监控读取的负载与截止

`readActiveWorkflowTasks()`与`readMaterialLibraryQueue()`只合并同一连接池、同一ID范围的在途读取，完成或失败即移除，不缓存上次成功/错误，也不合并不同本机范围。本机没有对应活动ID时直接返回空的本机投影，不查询PG；此时`known`仅表示本机集合为空，不表示PG健康，数据库连通性仍看health。

本机材料库明细与count均限定传入的任务ID，HTTP返回的历史数量仍来自SQLite聚合；legacy未传ID范围时保持全局读取。监控每条SQL取得连接后的驱动读取时限为5秒，当前createPool获取连接仍限15秒；这不是整个HTTP请求5秒截止。查询失败由pg-pool释放并销毁连接，API保留unavailable，不把失败伪装成零任务。独立步骤与材料摘要仍并行读取，不更改业务连接池大小、心跳或取消检查间隔。
