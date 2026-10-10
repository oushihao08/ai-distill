<!-- 文件职责：保存 resource monitor 的历史证据与检查记录；结论仅限文件注明的日期和范围。 -->
# 第四阶段⑥资源监控独立模块

2026-10-08：新增 `server/monitoring/resources.ts` 和针对性测试；未修改 worker、Codex 客户端、公共路由、数据库或调度状态。

## 能力与接入

`sampleResources({registered_pids,tasks})` 采集当前进程及明确登记的 PID。执行器负责登记/注销与 PID 生命周期（PID 重用不可由本模块可靠识别）。只执行 一次 `ps -p PID列表 -o pid=,rss=`，按登记 PID 拆分结果，重复行/缺失行 unknown，忽略未登记行，不读取命令行、环境或原始私有事件；采样超时 3 秒、输出上限 64 KiB、登记上限 256 个（含当前进程）。未知、失败、无权限、进程消失、RSS 为零或格式异常返回 `{status:'unknown'}`，不伪造零值。

系统仅 macOS 使用只读 `/usr/bin/memory_pressure -Q`（不使用会分配内存的 `-p`/`-l`/模拟参数）。返回系统报告比例 `available_percent`，物理总量和 `available_bytes_estimate = floor(total * percentage / 100)`，来源标为 `macos_memory_pressure_percentage`。它是内核可用资源百分比对应的估算，不是 Activity Monitor 的空闲字节、精确可分配内存或压力等级；比例只有整数精度，约有总量 1% 的量化误差，并且瞬时变化。其他平台或不能读取时 unknown。没有把 `os.freemem()` 当可用内存，也没有叠加可能重叠的 vm_stat 页。

执行器 `tasks` 只投影：复用 shared/types.ts 的 StepStatus，状态 waiting/running/succeeded/failed/skipped；最后事件 started/heartbeat/completed/failed/cancelled 与规范 UTC 时间；authentication ready/blocked/unknown；quota available/exhausted/unknown；error 安全分类。多余 message/body/path/原始事件/错误全部丢弃。`tasks` 缺失表示任务量未知，`[]` 必须由调用方确认为当前无任务。认证、额度与错误由执行器提供，模块不主动检查凭证或读取事件文件。

`adviseDispatch(snapshot,{min_available_percent,max_running_tasks?})` 的阈值必须调用方显式给出。低于比例阈值、达到任务并发上限、认证阻断、额度用完或限流返回 pause 和固定原因代码；读取或执行器就绪状态未知时 unknown，不声称可以派发。没有阻断和未知时 allow。建议仅作为数据返回，不杀进程、不取消当前任务、不写调度状态。接线方必须自行决定如何处理 unknown；失败任务的旧错误何时清除也由执行器负责。

接线尚未完成：Codex 当前客户端内部 spawn 没有对外 PID 登记/事件分类钩子；worker 未调用监控模块。主 agent 后续在进程启动/退出及允许事件更新时提供快照，再按项目资源策略消费建议。

## 验证

- `bun test server/monitoring/resources.test.ts`：40 passed，0 failed。覆盖内存/进程解析，异常数据和失败 unknown，PID 校验与去重、单命令批量采样和缺失/重复/未登记进程行，限定系统命令，事件隐私白名单，任务状态，显式阈值及建议无副作用。
- 独立 `tsc --noEmit --strict --skipLibCheck --target ESNext --module ESNext --moduleResolution Bundler --types bun --lib ESNext,DOM server/monitoring/resources.ts server/monitoring/resources.test.ts`：通过。
- 真实本机采样时间 2026-10-08T07:54:19.246Z：系统读取 known，物理总量 38,654,705,664 bytes，系统报告可用比例 40%，估算 15,461,882,265 bytes。只采当前 Bun 进程，RSS known 为 32,358,400 bytes；没有登记额外 PID，也没有查询其他进程。任务输入显式 `[]`，仅供此次采样检查，不代表实际 worker 无任务。调用方示例阈值 10% 得到 allow，不是默认阈值。
- 真实采样证明本机命令与解析兼容；不证明运行中的 worker/Codex 接线或长时间资源压力策略。

来源核对：[Apple 内存分析说明](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/ManagingMemory/Articles/VMPages.html) 解释 vm_stat 等工具；[Apple XNU vm_statistics.h](https://github.com/apple/darwin-xnu/blob/main/osfmk/mach/vm_statistics.h) 明确 speculative 已计入 free_count。`memory_pressure` 指标输出与 `-Q` 只读用法另核对本机工具实际行为；其整数比例不推导成精确可用字节。

批量 ps 调整后复核：2026-10-08T07:55:33.490Z 系统 known，可用比例 34%，估算 13,142,599,925 bytes，当前 Bun 进程 RSS known 32,423,936 bytes；仍仅当前进程。39 项测试和独立类型检查再次通过。

最终契约复核：任务状态直接复用 `StepStatus`，采用实际 `skipped`，取消事件 `cancelled` 保留。实际 skipped 统计回归测试已增加；40 项测试和独立类型检查通过。

## 后续授权：worker 监控接线模块

新增 `server/monitoring/worker-monitor.ts` / `.test.ts`，公共 worker、路由及前端由主线程统一接入。本模块冻结接口：

- `createWorkerMonitor(pool,root,{min_available_percent,sample_interval_ms?,sample?})` 返回 `start():Promise<void>`、`beforeDispatch():Promise<boolean>`、`stop():Promise<void>`。默认 5 秒，只读查询当前未删除项目/工作流、当前 input_revision 的 waiting/running 尝试，仅读 status/started_at/heartbeat_at，不读取 error、题目、附件或答案。
- 任务事件投影为 started/heartbeat 和 UTC 时间；认证、额度及错误并未主动检查，全部真实标 unknown，任务查询失败表示任务量 unknown。
- 本轮只采当前 worker PID，未登记材料/Codex 子进程，也不自动扫描。原有 `sampleResources` 仍支持调用方明确登记 PID；冻结 worker 接口没有 PID 登记方法。
- `beforeDispatch` 共用缓存和正在进行的采样，known 且低于显式阈值时暂停新领取，恢复后允许；unknown 明确保留且沿用既有派发。这是 `memory_only_unknown_allow` 策略。完整 `advice` 仍可能因认证/额度未检查为 unknown，两者分别返回，不能把派发允许描述成认证与额度均正常。没有杀进程、取消当前任务或数据库状态写入。
- `start` 安排可清理的定时器，`stop` 等待当前采样并写 stopped。采样及持久化错误被安全处理；写盘失败不清除内存中的低内存 gate。
- `.worker-monitor.json` 通过同目录随机临时文件（0600）+ rename 原子替换，保存安全快照、心跳、worker PID、dispatch 与 advice。没有数据库连接、工作路径或原始错误。临时文件尝试清理，不记录私有异常文本。
- `readWorkerMonitor(root)` 返回 `{status,heartbeat_at,worker_pid,dispatch,advice,snapshot}`。status 为 running/paused/stopped/stale/unavailable；缺失、不可读或非法文件 unavailable，心跳超过 30 秒或明显来自未来为 stale。读取按允许字段重建嵌套快照与派发结构，丢弃多余字段，重新计算固定原因 advice，防止原始字符串被带到接口。它没有证明 PID 仍存活；心跳鲜活是单 worker 运行状态的证据边界。

行为验证：9 项针对测试通过（低内存暂停与恢复、缓存/并发合并、unknown 策略、查询失败、写盘失败 gate、采样失败、篡改字段隐私投影、stale/损坏/缺失、stop 等待采样）。独立严格类型检查通过。

真实本机模块采样：2026-10-08T08:11:37.191Z，可用比例 76%，物理总量 38,654,705,664 bytes，估算可用 29,377,576,304 bytes；只当前采样 Bun 进程 RSS 34,406,400 bytes。临时目录完成原子记录并读取，随后 stop 与清理。数据库仅注入空行，不能据此声称真实数据库无任务；没有启动实际 worker 或调用生产模型。
