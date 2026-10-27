# 项目独立生命周期注册

供项目实现维护者使用。本目录是各项目在生命周期模块内的专属注册位置；公共步骤只传项目 key 和上下文，不直接导入某个项目的实现，不判断具体项目名。

| 文件 | 注册与行为 | 调用方 |
| --- | --- | --- |
| `work.ts` | Work的身份匹配、建题/出题/转换/渲染/作答/评分/交付投影注册，以及原准备/五件套入口 | `../steps.ts`、`../project-delivery.ts` |
| `work-contract.ts` | Work schema、字段类型、同源投影与交付结构要求；原路径保留转出兼容 | Work注册与既有项目交付代码 |
| `doubao.ts` | `豆包高经济价值`：保留归档前脚本路径；归档后同步对应期次飞书，检查最终回执 | `../project-delivery.ts`、`../publication.ts` |

## 代码边界

- 本目录维护项目 key、执行点注册、专属回调和调用依赖；不是在公共步骤里搬入新的项目判断。
- 大型专业实现仍复用已有模块。例如 Work 五件套格式保留在仓库 projects/Work法律全场景/scripts，飞书协议和回执保留在 server/publishing/feishu.ts。本目录负责连接它们，不复制它们。
- 公共步骤保留任务领取、通用输入、取消、数据库写回、通用版本绑定和失败结算。默认脚本适配保留在 lifecycle/project-delivery.ts；它不包含某个项目的业务规则。
- Work出题计划从`../default-authoring-plan.ts`取得默认值后仅覆盖项目差异；判据格式化共用`../default-projection.ts`，`projectRule`保留原导出名，不维护第二份文案。
- 交付key来自主项目parent_name；其他入口经resolveStepProjectKey兼容已有身份，规则由项目自己注册。期次project_id用于配置及身份查找，不能拿期次名称当项目key。飞书仍独立验证固定主项目资格，key 不是授权凭证。

## 增加或修改项目

1. 在本目录新增一个项目文件，导出该项目的注册函数，注册 key 必须精确且唯一。
2. 纯策略在`../steps.ts`显式调用注册函数，外部交付在对应生命周期入口装配。项目文件仅 type-import 入口上下文，避免运行时循环依赖。无动态目录扫描。
3. 把专属行为放进注册的实现，公共步骤只调用`projectStepPolicies.<执行点>.execute(resolveStepProjectKey(identity),input)`或统一交付入口。新的步骤执行点可以实例化同一 ProjectImplementations，不需要改注册器枚举。
4. 编写项目隔离、顺序、失败和默认回退测试，再更新本表及该业务模块 README。

实际注册入口：Work使用`registerWorkSteps(registries,keys)`和`registerWorkDelivery()`；豆包使用`registerDoubaoDelivery()`、`registerDoubaoPublication()`。纯策略入口统一为`projectStepPolicies.<执行点>.execute(key,input)`；外部实现统一通过`executeProjectDelivery()`与`completeProjectPublication()`等待。

回调有依赖时必须写在一个实现中逐个 await，不能并行派发。项目必需实现出错向步骤传播；可选通知才使用 LifecycleRegistry。注册表没有自动重试和持久检查点：项目外部副作用复用现有检查点/回执，失败后按实际状态恢复。

## 状态与恢复

Work 必需交付失败时不写本地归档成功。豆包飞书要求先有本地归档，飞书失败保留该归档及独立回执，报告交付未完成、不发完整交付成功事件；显式飞书补传只补上传，不重新出题/作答/评分/归档。远端删除、正在同步、未启用和失败回执均不能当作本次上传成功。

测试采用 SQL、交付器及飞书替身，可验证分派和顺序；不等于真实平台验收。代码变更不自动重启服务或修改现有业务数据。

## 注册规则与维护清单

豆包在出题/作答/评分采用默认通用实现，不为对称性复制一套空实现。需要新增项目事件时，在项目独立文件中导出注册函数，由lifecycle/index装配到公共LifecycleRegistry；订阅填写project_key，不用每期复制代码。

修改时核对：匹配条件、输入白名单、返回值、执行顺序、失败时机及历史输入摘要。纯策略不能访问数据库或发网络请求，必须同步返回；外部动作须逐个await并复用原检查点/回执。不把专业准入偷偷放进出题或作答返回后的策略。类型上的work_legal_v1仍是历史数据协议，不是公共步骤中的项目分支。

新旧注册须有普通项目、豆包、旧Work、新Work的隔离和回退用例。迁移前基线在`../fixtures/flow-baseline.json`，由改动前源码及合成输入采集，不可为让测试通过直接重生成；行为变化必须另行明确授权。该基线不包含用户题目、凭证或业务数据库数据。
