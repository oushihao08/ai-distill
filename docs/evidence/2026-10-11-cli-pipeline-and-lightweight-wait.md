# CLI 逐题推进及轻量等待验证

日期：2026-10-11。对应[实施计划](../plans/2026-10-11-cli-pipeline-and-lightweight-wait.md)。本记录只证明源码、指令及合成单测范围，不证明真实模型表现、AI 编排行为、百题耗时或整机内存收益。

## 已实施

| 位置 | 修改 | 保留能力与边界 |
| --- | --- | --- |
| `skill/SKILL.md` | 同批逐题读服务端就绪状态后分组派发；没有可派发项才短等待并刷新全组 | 固定范围、原分组、用户终点、失败跳过、未知写结果先核实、活动尝试不重派；显式整批等待要求优先 |
| `cli/commands.ts` | `attempt wait` 默认请求轻量视图并白名单保存元信息；正文用 `--full` 或 `attempt show` | ID、状态、错误、日期与单项读取失败保留；兼容旧服务忽略视图时的本地投影 |
| `server/attempts.ts`、`app.ts` | `view=status` SQL 不读取 result；等待查询由 250ms 改为 1000ms，剩余预算更短则缩短睡眠 | 默认 HTTP 和 `view=full` 仍读完整结果；取消唤醒不取消持久任务；未知视图返回400 |
| `server/routes.test.ts` | 测试存储根目录由 `/unused` 改为每例独立临时目录 | 只修测试夹具，避免 createApp 读取本机并发设置时写不可写目录；生产配置不变 |

作者 Codex 模型、推理、工具、配置、权限、新会话、附件和 skill 输入边界不修改；worker 领取锁、并发和业务判断不修改。

## 定向验证

| 命令／检查 | 实际结果 |
| --- | --- |
| `bun test ./server/attempts.test.ts ./cli/client.test.ts ./cli/commands.test.ts` | 31通过、0失败；含4项新等待单测、2项新CLI兼容用例，以及原HTTP安全、多模型、超时、未知写结果及固定范围用例 |
| `bun test ./server/routes.test.ts --test-name-pattern 'attempt status\|disconnecting a wait\|invalid wait duration'` | 7通过、0失败；覆盖默认完整读取、新状态视图、非法视图、取消与等待参数校验 |
| 完整相关三文件：attempts、CLI commands、routes | 52通过、11失败。新行为全部通过；失败清单见下文 |
| 临时副本基线 | 从当前源码撤去本次 app 视图及 attempts 投影／间隔实现，去掉新路由用例，保留同样的可写测试夹具，原路由集25通过、11失败，失败项与修改后一致。未改写工作区或业务数据，临时副本已清理 |
| `git diff --check` | 通过 |

未启动服务、重启进程、写业务数据库或调用真实模型。当前项目有其他已有修改，此记录不把整个工作区差异归为本次修改。

## 完整路由集的11项既有失败

临时基线及当前完整路由集均失败：

1. authored question public package can be downloaded through the artifact whitelist
2. workflow detail hides internal rule binding and extraction stages
3. optional redacted DOCX export is separate from workflow steps and safely downloadable
4. step four authoring route is wired and refuses incomplete current prerequisites
5. step four is accepted by the batch route and reports unready prerequisites
6. rule mutation parameters are validated before touching files or database
7. synchronous extraction waits for the same queued attempt without creating another
8. synchronous timeout returns the attempt ID and leaves the queued job intact
9. project batch queues each ready workflow once and isolates unready or missing records
10. batch endpoint validates step number, workflow IDs, and batch size
11. a 100-question batch queues exactly the 99 whose previous step succeeded

可见失配包括下载文件名预期旧值、夹具查询前缀落后于实现、对已隐藏 ordinal 2 的批量请求仍预期成功；未在本次性能修改中重写这些不相关契约或断言，完整路由集不能声称全通过。

## 尚未验收

- AI 是否实际按新 skill 在同批内及时推进其他就绪题，且多模型和失败处理符合指令。
- 相同题目、模型与并发下的总耗时、状态查询量及内存峰值前后对比。此前3.5–5小时只是理论估算，不是本次测试结果。
- 服务进程加载新实现；后端需下次重启才加载，CLI和操作 skill 下次执行即可读取新内容。旧服务忽略轻量视图时 CLI 投影仍生效，但数据库正文读取和一秒轮询优化尚不生效。
