# 远程 CLI 启用与双机验收清单

更新时间：2026-10-14

## 当前结论

远程材料和远程作答的代码入口、CLI 命令及 Skill/CLI 工具地图已具备。CLI 使用本机固定凭证，经 SSH 隧道请求服务器 API；服务器复用现有数据库和持久化 worker 队列。

**当前只能确认代码与文档已准备，不能确认服务器已经可用。** 真实服务器部署、数据库迁移状态、远程材料闭环、远程作答和本地/服务器 worker 隔离尚未在本清单中验证。上轮代码工作记录的 TypeScript 检查通过不代表部署或端到端验收通过。本次只补文档，没有执行测试、迁移、服务重启、模型请求或远程业务任务。

已有设计和实现记录见[远程材料与作答闭环计划](2026-10-13-remote-intake-redaction.md)；命令用法见 [CLI README](../../cli/README.md)，能力和源码定位见 [Skill/CLI 工具地图](../../skill/MAP.md#cli-工具地图)。本文件只跟踪启用前置和验收，不重复定义 API 契约。

## 当前支持范围

| 能力 | CLI 命令 | 执行位置 | 当前代码边界 |
| --- | --- | --- | --- |
| 入库、PDF 提取、脱敏 | `remote material start/run/status/sync` | 服务器 API/worker | 按单题和固定 request-key 操作；成功后 CLI 校验并同步本机管理文件 |
| 模型作答 | `remote answer start/run/status` | 服务器 API/worker | 使用现有项目模型配置；状态命令不返回答案正文；不支持项目步骤钩子 |
| Agent 出题 | 无远程命令 | 本机作者执行链 | 服务器 worker 不处理 Agent 队列 |
| 独立评分、达标判定、归档 | 无远程命令 | 现有本机/API流程 | 本远程 worker 不处理这些队列 |

CLI 的 `run` 是“提交并等待”；中断不会取消服务器任务。写请求结果不确定时，必须用原 `workflow_id` 和 `request_key` 查询/恢复，不能换新 key 重发。材料命令的 `sync` 只收尾已成功的操作。

## 启用前置检查

只有以下项目逐项确认后，才进入真实远程验收：

- [ ] 服务器运行与本机相同版本的代码，且已部署 `remote-material` 与 `remote-answer` 路由及 `WORKER_MODE=server` worker。
- [ ] 服务器和本机连接同一业务数据库；运行数据库已登记 `034_remote_material_operations.sql`。按仓库迁移规则核对迁移状态，不盲跑全量迁移。
- [ ] 服务器 API 配置 `MATERIAL_EXECUTION_TARGET=server`；worker 配置 `WORKER_MODE=server` 和 `MATERIAL_EXECUTION_TARGET=server`。
- [ ] 服务器 `REMOTE_MATERIAL_TOKEN` 长度不少于32字符；本机 `.env` 的 `REMOTE_MATERIAL_TOKEN` 与其一致。不得在终端输出、命令参数、提交记录或任务日志中暴露 token。
- [ ] 本机 `REMOTE_MATERIAL_API_URL` 指向 SSH 隧道的本机回环地址；服务器 API 不需要向公网开放。
- [ ] 服务器已同步要处理的题目来源目录及项目资料；目录挂载位置与数据库保存的绝对路径一致，源文件指纹符合服务端校验。
- [ ] 远程作答所用项目模型集合、阈值/策略和服务器对应供应商凭证已准备；先确定获准使用的一道测试题和请求额度。
- [ ] 确认测试范围、测试工作流 ID、材料及作答是否可写入共享数据库；真实模型请求可能产生费用。

前置条件只读核验。任何一项未知时记录为“未确认”，不能用 CLI 源码存在或 API health 正常替代。

## 双机验收顺序

以下是待执行验收计划，不是本次已执行的操作。需在明确测试题和环境后逐项记录运行日期、部署版本、workflow ID、operation/attempt ID、结果及证据位置；不得记录原文或凭证。

### 1. 接口与认证

- [ ] SSH 隧道只把服务器回环 API 映射到本机回环地址。
- [ ] 无 token、错误 token、过短服务端 token 的行为符合预期；响应与日志不回显 token。
- [ ] 通过本机 CLI 完成一次只读远程状态查询，确认请求到达目标部署版本。

### 2. 远程入库与脱敏

- [ ] 对获准的单题使用 `remote material run --mode intake-redact`，保存返回的 operation ID 和 request-key。
- [ ] 服务器 operation 到达终态；入库、PDF 内部提取及脱敏状态分别符合预期，不把“入库成功”当成“脱敏成功”。
- [ ] 使用同一 workflow ID 与 request-key 重复查询/提交，确认返回原 operation，不创建重复任务。
- [ ] 执行 `sync`，确认本机管理副本逐件 SHA-256 一致；已有冲突文件时命令停止且不覆盖。
- [ ] 经常规工作流状态接口确认本机后续出题所需的材料和脱敏结果可见；保留识别问题和脱敏失败信息。

### 3. 远程作答

- [ ] 在已配置的测试工作流上使用 `remote answer run`，保存 request-key 与全部返回的 attempt ID。
- [ ] 服务器 attempt 的执行归属为 `server`，全部模型尝试达到终态；检查失败项及服务端错误，不只看总体 outcome。
- [ ] 用相同 workflow ID 与 request-key 查询，确认不重复创建答案；`status` 不返回答案正文。
- [ ] 经现有工作流结果接口读取答案，确认数据与当前题面、附件和项目模型绑定一致。

### 4. 隔离与旧功能

- [ ] 确认本机普通任务仍由 `execution_target=local` worker 领取，服务器 worker 不领取本地 attempt。
- [ ] 确认服务器 worker 只领取服务器归属材料任务及无步骤钩子的作答，不领取 Agent 出题、评分或达标任务。
- [ ] 本地原有工作流 API 和页面仍能读取远程写入的题目/答案；部署前后的服务日志不含凭证或材料正文。

## 验收结论格式

验收完成后逐项标记“通过／失败／未执行”，并附最少必要证据：部署版本、测试 workflow ID、operation/attempt ID、状态接口结果和哈希同步结果。只有材料、作答和隔离检查均通过，才能结论为“远程入库/脱敏/作答已在目标服务器验收”。

即使远程三步通过，也**不代表**服务器支持完整法律工作流；Agent 出题、独立评分、达标判定和归档仍按当前本机执行边界处理。线上变更和可能产生费用的模型作答，须遵守项目运行授权规则。
