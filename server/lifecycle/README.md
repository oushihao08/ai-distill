# 生命周期与项目策略

供公共步骤和项目扩展维护者使用。本模块按主项目key选择专属实现，并在步骤边界顺序执行回调。公共步骤保留任务领取、通用输入、模型调用、事务、取消、版本绑定和结果保存；生命周期不调度步骤、不修改分数和门槛、不自动返修。

## 文件与调用关系

| 文件 | 职责 |
| --- | --- |
| `project-registry.ts` | 必需异步实现（`ProjectImplementations`）、同步纯策略（`SyncProjectImplementations`）及项目身份匹配（`ProjectKeyRegistry`）注册器；精确选中一个实现，无注册走默认 |
| `step-types.ts`、`steps.ts` | 1—7项目策略类型、默认行为及项目注册装配，供公共步骤调用 |
| `default-projection.ts` | 普通题包投影，供默认策略与项目旧契约回退复用 |
| `default-authoring-plan.ts` | 默认出题计划纯工厂；通用策略与Work旧契约共用，项目只覆盖差异字段 |
| `registry.ts`、`index.ts` | 可选通知注册与发出（`LifecycleRegistry`）、单步回调隔离执行器（`runLifecycleTask`）、主项目key路由及安全日志 |
| `scripts.ts` | 原before/after配置的同步适配、持久记录和主调用检查点（直接复用 `runLifecycleTask`，不创建临时注册表实例） |
| `project-delivery.ts` | 归档前准备/交付统一入口，复用原项目脚本和检查点 |
| `publication.ts` | 本地归档后的项目交付统一入口 |
| `scoring.ts` | 评分汇总结算后通过 `runLifecycleTask` 接续达标判断，失败独立记录 |
| `projects/` | [各项目独立注册位置](projects/README.md)，保存项目规则与适配 |
| `registry.test.ts`、`project-registry.test.ts` | 注册、分派、顺序、隔离、异常、取消和跳过用例 |
| `flow.fixture.ts`、`flow.test.ts`、`fixtures/flow-baseline.json` | 合成输入、迁移前固定输出及跨步骤回归；不是业务输入 |

## 三类扩展机制选型边界

| 机制 | 容器 / 入口 | 适用场景 | 失败语义 |
| --- | --- | --- | --- |
| 同步纯策略 | `SyncProjectImplementations`（`steps.ts`、`material-docx.ts`） | Schema 构造、题包归一化、公开/私有投影、步骤就绪判断、DOCX 布局选择（纯内存同步计算，禁查库/禁网络） | 异常原样向当前步骤抛出 |
| 必需异步分派 | `ProjectImplementations`（`project-delivery.ts`、`publication.ts`） | 步骤 8 归档前准备/五件套生成、本地归档后飞书同步等必需业务动作 | 异常原样向调用方抛出，由调用方按阶段契约结算 |
| 可选阶段通知 / 钩子 | `LifecycleRegistry` / `runLifecycleTask`（`index.ts`、`scripts.ts`、`scoring.ts`） | 阶段事件广播、钩子脚本执行、评分后自动触发达标判断 | 异常被捕获为 `{ status: 'failed' \| 'cancelled' }` 并记录日志，不回滚主步骤已提交结果 |

## 1—7项目策略执行点

公共调用方式为`projectStepPolicies.<执行点>.execute(resolveStepProjectKey(identity), input)`。项目专属选择条件在`projects/`中维护，公共步骤不增加Work/豆包名称或契约分支。

| 执行点 | 公共调用位置 | 已注册行为 |
| --- | --- | --- |
| `materialQuestion` | 材料库建题事务取得原锁后 | Work一包一题；其他项目默认无此限制 |
| `authoringPlan` | 作者调用前 | Work新旧schema、提示段、交卷字段与原配置要求 |
| `normalize` | 题包接收 | Work同源派生题面/标答；不增加内容准入 |
| `packageProjection` | 公开/私有题包渲染 | Work判据及私有业务字段；豆包考点普通数字编号；公开包不泄露标答或思路 |
| `authoringVersion` | 题目版本摘要输入组装 | 保持Work原字段和序列，不补写历史任务 |
| `answerIssue` | 原题检查、就绪与作答派发 | Work草稿/能力规则；通用文字能力和白名单仍由作答入口维护 |
| `scoreProtocol` | 新评分派发、旧任务绑定复核 | Work选择引文协议；无标记历史任务不补造标记 |
| `publicationFields`、`archiveDownload` | 项目交付载荷、原五件套下载 | Work字段投影与下载资格，保留原包协议 |

入库提取、脱敏模式、供应商适配、模型集合、评分协议执行、阈值及聚合继续使用通用代码。没有项目差异时使用默认实现，不复制空项目流程；新增或跳过步骤不要求先登记空策略。

`SyncProjectImplementations`用于schema、转换、渲染和就绪等纯策略，在当前调用栈返回，不能返回Promise、访问数据库或发网络请求。`ProjectImplementations`用于外部必需实现，调用者必须await；异常向原步骤传播，不作为可选通知吞掉。

默认出题文字只在`defaultAuthoringPlan()`维护，项目在返回值上覆盖专属字段；每次调用新建计划及可覆盖的配置对象，不修改输入schema/选项。`default-projection.ts`的`formatCriterionRule()`供通用题包接收和项目渲染共用，Work的`projectRule`保留为兼容导出。它只投影文本，不增加内容准入；修改措辞会影响题包正文及版本，须通过固定输出对比，不能随去重顺手改写。

## 项目key与输入边界

key代表主项目，project_id代表期次UUID。同一主项目各期共用注册，期次配置仍由原入口读取。`resolveStepProjectKey()`优先接收显式key，兼容识别由项目自己登记；默认名称沿用`主项目 - 期次`格式。Work作者保留原名称/目录识别，题包与评分保留冻结契约兼容；建题只传原parent_name/name，避免扩大原限制。

key通过执行上下文传到作者转换/渲染、保存恢复、作答原题检查、就绪及评分选择，不加入模型输入或旧digest。更名时同步检查注册key、目录与期次配置；key不替代项目权限或飞书资格校验。

## 生命周期通知

在项目独立文件导出注册函数，由启动装配调用`lifecycle.register({id,stage,event,project_id?,project_key?,run})`，返回值可注销。同一注册表id唯一，无动态目录扫描；API和worker需要的注册须在各自进程加载。

事件为`before`、`committed`、`failed`、`cancelled`、`skipped`；阶段名为开放字符串，当前入口包含intake、extract、redact、authoring、answer、scoring、acceptance、delivery。材料库使用library job ID，无workflow时不伪造题目身份。

公共步骤调用`emitProjectLifecycle(pool,event,context)`。仅存在按key订阅、且上下文有期次/题目身份时读取主项目身份；无项目材料只运行通用回调，无key订阅不增加查询。身份读取失败记安全错误，不猜测项目、不把已保存主结果改失败，通用回调仍继续。

一次事件固定匹配列表，按注册顺序逐个await。每个回调获得独立数据副本；异常形成失败结果并记录日志，不回滚主结果。取消后不继续普通回调，仍可发送失败/取消通知；跳过只发送skipped。依赖动作写在同一实现内顺序执行，不并行派发。进程内通知不提供持久恢复或跨进程恰好一次保证。

## 项目交付与失败

`publishWorkflow → executeProjectDelivery(key,context) → 项目准备/交付 → 公共归档保存`，随后`runNextPublication → completeProjectPublication(key,context)`。外部动作期间不持有公共归档事务连接。

Work必需五件套失败不提交归档。豆包飞书在本地归档后执行，等待最终回执；非成功回执不发完整交付committed，不回滚本地归档，也不进入归档重跑路径。飞书补传只补远端同步，复用自身回执与一致性核对。

## 原脚本配置、历史队列与恢复

原workflow.hooks接口仍只配置出题/作答/评分三个阶段；这不限制代码注册的生命周期阶段。新冻结动作统一sync，主调用内逐个等待；旧冻结动作中的async声明在新同步执行路径中也按顺序等待。

主结果和后置待执行记录同事务保存，事务释放后执行脚本；失败独立记录，不将主结果改失败。记录复用hook_runs，无脚本时不访问该表。主调用检查点用于明确恢复时避免重复模型调用。

已经独立登记到本机队列的历史hook任务仍由`execution-queue/worker.ts → workflow-hook-worker.ts`兼容消费；主worker的legacy分支不新增独立hook轮询池，新生命周期路径不向该历史队列派发任务。历史记录不自动删除或批量转换。

`POST /api/hooks/:id/retry`同步补执行单增强并返回终态，不创建队列任务。运行中/未知副作用先核实，非幂等重试须显式确认，成功记录复用。`resume-hooks`只兼容旧失败主尝试恢复，不代替新后置增强补执行。

仍有调用的work-contract旧路径、workAnswerCapabilityIssue别名、singleQuestionPerPackage门面及Siriser专属下载保留；它们不维护第二套项目规则。共享类型中的历史契约标识不作为公共项目分支。

## 验证与维护

固定输出基线只包含合成输入，覆盖普通项目、豆包、旧Work与新Work的提示词、schema、投影、版本和评分指令。不能为让测试通过直接重生成。串联与队列测试使用本地临时文件/SQL/执行器替身，不等于真实模型、数据库或平台验收；实际执行证据保存在仓库执行观察中。

修改项目策略时同步更新项目注册说明和受影响模块README，核对单题/批量/恢复入口、默认回退及历史摘要。代码更新不代表常驻服务已加载，重载、迁移和真实调用按仓库授权执行。

## 材料DOCX布局

`material-docx.ts` 提供同步纯策略，材料导出器调用 `materialDocxLayout(identity)`。默认逐文书 `separate`，Work及未注册项目沿用此默认；`projects/doubao-materials.ts` 将豆包高经济价值及旧名豆包高经注册为 `combined`。新项目可通过 `registerMaterialDocxLayout(key, layout)` 注册差异；布局不改变脱敏、来源模式或业务步骤。逐份文件名使用分册名称及序号，正文不增加标题；合并由公共组合器处理边界标题。
