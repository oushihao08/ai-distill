# 执行观察

- [运行卡点、本机状态与页面队列一致性长任务](runtime-consistency-20261024/任务说明.md)：目标、失败停止预算、动态清单及自主执行边界；[动态总览](runtime-consistency-20261024/总览.md)。

本目录记录仓库级多阶段任务的事实、尝试与证据，避开项目材料和 skill 输入目录。JSON 为事实源，任务内总览由 Trace 工具生成。

- [材料代码质量修复](material-quality-quickfix-20261026/总览.md)：提取清理与下载边界、检查点v2、问题页子集复识别、回滚原件安全回收及遗留代码维护；保留用户确认的垃圾清理设计。隔离验证不代表真实供应商或PG并发验收。

- [豆包第六期首次评分难度复判（2026-10-25）](doubao6-first-score-difficulty-20261025/报告.md)：14题历史出题、作答与评分绑定，已证实的得分结构问题及skill/期次提示词建议；未实施或重跑模型。

- [运行卡顿问题清单（2026-10-23）](运行卡顿问题清单-20261023.md)：数据库等待、模型阶段耗时、评分断流、遗留状态和日志观测缺口的调查快照、证据边界及修复验收建议；不是 Trace 生成总览。

| 任务目录 | 用途 |
| --- | --- |
| [deepseek-score-compare-20261026](deepseek-score-compare-20261026/总览.md) | 第六期10道达标题的DeepSeek API独立对照评分；原输入指纹一致，不改业务评分。 |
| [scoring-project-standards-20261025](scoring-project-standards-20261025/总览.md) | 三个业务期次评分提示词与项目规范对齐，HTTP保存及回读；不重评历史。 |
| [work-two-ready-20261025](work-two-ready-20261025/总览.md) | 固定Work的L2劳务合同、L3承揽合同纠纷两包，复用成功提取，修复Agent脱敏并在豆包第六期完成出题、作答和独立评分。 |
| [doubao-phase6-library-audit-20261023](doubao-phase6-library-audit-20261023/总览.md) | 豆包第六期 questions 目录 80 个材料包的入库、提取、Agent 脱敏及加载；按目录标题匹配，不创建题目或移除无关关系。 |
| [material-package-audit-20261021](material-package-audit-20261021/总览.md) | 材料包分支、两种脱敏模板、原文/脱敏来源与CLI的隔离副本回归；真实运行与源码检查分别记录。 |
| [pace-skill-20261018](pace-skill-20261018/总览.md) | 全局Pace提效Skill的实现、独立纸面场景与格式核验；不代表业务并发改造或实际提速。 |
| [shared-material-library-design-20261017](shared-material-library-design-20261017/总览.md) | 独立材料库设计及后续实施追溯；总览分别标识设计证据与代码/运行验收。 |
| [redaction-output-20261018](redaction-output-20261018/总览.md) | 脱敏输出上限、切批和结束原因日志的修改与材料包实测。 |
| [doubao-library-real-flow-20261018](doubao-library-real-flow-20261018/总览.md) | 豆包项目隔离副本的材料库真实链路恢复测试；原项目与原始PDF保持不变。 |
| [doubao-phase6-work-materials-20261021](doubao-phase6-work-materials-20261021/总览.md) | 豆包第六期加载两份Work材料包并跑完整流程；记录材料分册输入、来源隔离和阶段结果。 |
| [database-performance-audit-20261019](database-performance-audit-20261019/总览.md) | 本地数据库/API查询慢根因、最小查询改动、测试与运行态复测；尚未加载新API代码。 |
| [repo-docs-cli-20261019](repo-docs-cli-20261019/总览.md) | 排除 `docs/` 后核对工程文档、源码注释与 CLI 对当前材料库、期次和工作流契约的覆盖。 |

- [任务失败恢复与停滞修复](workflow-recovery-20261023/本轮结果.md)：源码修复、隔离故障验证及测试隔离失误记录。

- [工作流可靠性与CLI代码质量修复](workflow-quality-20261023/总览.md)：领取范围、材料终态恢复、异步完整交付、CLI公平等待与私有诊断的隔离验证。

- [两种材料流程与新期创建改造](two-mode-project-flow-20261023/task.json)：七项改造、048定向迁移、双模式隔离链路及创建回执恢复浏览器证据；合成模型程序验证与真实模型质量分开记录。

本次飞书一致性目标沿用已有等效记录：[task.json](../.storage/automation-runs/feishu-phase6-reconcile-20261025/task.json)，同目录保留70题补传及对账证据，不重复创建任务台账。
| [doubao6-extract-deadline-20261025](doubao6-extract-deadline-20261025/总览.md) | 豆包第六期四包材料提取超时诊断、65分钟外部提取预算修复及安全重启待办。 |

- [出题作答评分三项维护重构](author-answer-score-refactor-20261026/方案.md)：共用心跳、删除不可达评分分支及展开密集代码；隔离测试证据见同目录总览。

- [Worker与数据库卡顿复核](worker-hang-inspection-20261026/最终复核.md)：六项逐条核实、长期等待日志及具体修改点；只读调查，未实施修复。

- [Worker修改前后同条件对照](worker-hang-inspection-20261026/前后对照.md)：每版10轮、400题本地协议夹具，包含性能代价；不代表长期生产验收。
