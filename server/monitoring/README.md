<!-- 文件职责：说明 worker 与本机资源监控的采集和报告接口。 -->
# 本地 worker 监控

采样本机内存、进程、数据库等待／运行任务及心跳，向 API 提供安全本地快照并控制派发；监控接口另返回正在运行的项目步骤和独立材料库队列，不把全局库任务重复归属到项目。

## 文件职责

| 文件 | 说明 |
| --- | --- |
| `resources.ts` | 本地资源采样与建议：解析 macOS 内存和进程数据，将未知值显式表达并计算派发建议。 |
| `worker-monitor.ts` | worker 安全监控：采集任务与资源心跳、写入共享快照并据内存阈值控制新任务派发；查询活动工作流尝试与材料库队列，并只投影允许的进度字段。 |

## 数据流与依赖

worker-monitor.ts 在 worker 生命周期采样并写共享存储快照；resources.ts 解析 macOS 资源与未知值；API 读取快照并查询运行中尝试的安全摘要和 `library_jobs` 汇总；前端 WorkerMonitor 展示全局材料库的排队/运行计数及有限安全进度。旧数据库尚无材料库迁移时，队列状态显示 unavailable，不影响 legacy worker 派发。

## 维护边界

内存不足暂停新领取，不能当成强制停止正常任务；未知采样值显式展示。API 与 worker 须共用存储路径。子进程、真实登录额度和完整故障恢复不因快照存在就算验收。

本模块的 `*.test.ts` 保留既有验证意图；存在测试文件不表示本次运行。执行与授权遵循 [项目规则](../../AGENTS.md)。

监控将数据库任务统计与本机内存采样分开刷新。派发只等待内存采样；任务统计使用专用数据库连接，在只读事务内设置2秒 PostgreSQL `statement_timeout`，提交或失败回滚后立即释放连接。统计失败时任务状态显示未知，不改变内存派发阈值。停止时等待在途采样与查询结束，再写入最终停止状态；迟到的任务查询结果不会覆盖停止快照。连接池获取不包含在 SQL 执行上限内。

## 判断边界与已知投影限制

- 真正的`beforeDispatch()`只按已知低内存暂停新领取，内存unknown时允许继续；`adviseDispatch()`给出的认证、额度或任务数建议不直接成为派发闸门。不能把advice=unknown误读为任务停止。
- 系统内存估计只实现macOS的memory_pressure，其余系统为unknown；进程采样只包含当前worker和登记Agent PID，不扫描所有系统进程或读取参数/环境。
- 共享`.worker-monitor.json`是同存储位置最后写入的worker快照，不是多worker合并清单。30秒以上旧心跳（或未来偏移超过5秒）投影为stale；stale不能证明供应商任务已经结束，也不能据此自动重派。
- `readActiveWorkflowTasks()`最多返回500条运行尝试；当前channel的SQL按ordinal固定把5标api、4/6标agent，只有9读取provider。因此Codex作答和API评分的channel可能误标，不能拿该字段计算真实Agent/API占用；需核对attempt冻结config与worker队列。
- 全局库计数是任务历史状态数，非去重材料包数；活动明细最多100条，计数可能大于明细长度。安全progress只含白名单计数，是本地执行器阶段信息，不是供应商token/页生成进度。
- 项目任务统计查询不含library_jobs，后者通过独立队列摘要展示。快照中的auth/quota通常为unknown，不进行实时登录/额度探针。

`resources.test.ts`通过注入命令输出核对解析/PID/建议；`worker-monitor.test.ts`使用临时文件、注入数据库与采样检查共享写入、低内存/未知、统计超时、停止等待和投影。它们不证明真实OS资源、供应商进度或多机监控。
