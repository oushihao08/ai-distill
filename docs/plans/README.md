<!-- 文件职责：说明计划文档的维护方式及其与实现、证据的区别。 -->
# 实施计划

本目录保存待实施或阶段性实施计划。计划描述目标、约束和验收方法，不证明代码已实现或通过验收。检查具体计划正文中的日期、状态和范围，并用当前源码及对应历史证据复核。

| 文件 | 用途 |
| --- | --- |
| [2026-10-11-cli-pipeline-and-lightweight-wait.md](2026-10-11-cli-pipeline-and-lightweight-wait.md) | 同批逐题推进、CLI轻量等待及一秒状态轮询；实现与定向测试记录，保留完整读取及Codex能力边界。 |
| [2026-10-11-answer-duration-and-run-followups.md](2026-10-11-answer-duration-and-run-followups.md) | 稳健整改顺序、作者能力与正常流程不退化、配置／自检收口、45分钟证据及免评分分阶段启用、内容对照、回退与验收；实施中，含主目录合入与运行证据及未完成门槛。 |
| [2026-10-11-codex-workflow-cli-skill.md](2026-10-11-codex-workflow-cli-skill.md) | 将现有入库至归档/导出流程包装为本地 CLI 与 Codex Workflow Skill 的实施计划；复用 API/worker/Agent 执行器，维持显式逐步编排与当前业务边界。 |
| [2026-10-11-codex-manual-capability-alignment.md](2026-10-11-codex-manual-capability-alignment.md) | 列出后端出题 Codex 与桌面手动使用的剩余差距、修改理由、收益、能力不退化约束和逐项验收；当前仅形成清单。 |
| [2026-10-11-authoring-to-scoring-observation-test.md](2026-10-11-authoring-to-scoring-observation-test.md) | 记录题目2–6、8正式后端出题、作答、评分及达标流程的计划和执行边界；六题后端运行结果见对应 evidence，严格同输入桌面对照仍未完成。 |
| [2026-10-11-worker-performance-reliability.md](2026-10-11-worker-performance-reliability.md) | Worker 数据库争用、取消、停止和队列公平性；代码与单测已实施，隔离 PostgreSQL 和真实运行指标未验收。 |
| [2026-10-10-legal-skill-final-selected-refinements.md](2026-10-10-legal-skill-final-selected-refinements.md) | 仅保留净收益严格大于0.4的修改：F1—F4已落实并保留原有设计；第二案例F5仍待对应完整来源。已检查文本差异和链接，未测评。 |
| [2026-10-10-legal-skill-evidence-and-research.md](2026-10-10-legal-skill-evidence-and-research.md) | 第五期 skill 的作者检索、证据相互印证及明确判分条件完善方案；skill 文本已修改并检查，未进行新出题或模型测评。 |
| [2026-10-10-fresh-authoring-desktop-alignment.md](2026-10-10-fresh-authoring-desktop-alignment.md) | 普通出题从零生成、项目工作目录及桌面 Codex 能力对齐方案；明确旧队列兼容、私有文件交付、合格状态及分层验收。后续正式队列已完成题目2—6、8的出题至评分，工具逐项等价仍需核对；取代旧普通重出历史反馈目标。 |
| [2026-10-10-legal-skill-final-improvement.md](2026-10-10-legal-skill-final-improvement.md) | 综合 inbox 提炼与优化清单，提出可裁决误读、必要结果及中立验收的第五期法务出题 skill 最终改进方案；skill 文本已修改，真实成题与模型测评未完成。 |
| [2026-10-10-legal-skill-depth-improvement.md](2026-10-10-legal-skill-depth-improvement.md) | 第五期法务出题 skill 的九项修改、有效原因、实施方法、任务依赖及分层验收；仅计划，未修改 skill 或开展难度测评。 |
| [2026-10-10-legal-skill-optimization-inventory.md](2026-10-10-legal-skill-optimization-inventory.md) | 历史普通重出反馈筛选方案及skill优化清单；其中自动带入评分的目标已被从零出题方案取代，不作为当前普通出题要求。 |
| [2026-10-09-optional-redacted-docx-export.md](2026-10-09-optional-redacted-docx-export.md) | 旧版可选文字 DOCX 的实施记录；2026-10-11 补充结构化脱敏入库、无遗漏文本投影与同源样式 DOCX 计划，新增部分待实施，含兼容、回退与验收标准。 |
| [2026-10-09-independent-agent-executor.md](2026-10-09-independent-agent-executor.md) | 独立任务执行模块边界、统一调用契约、本地 Codex 迁移清单及后续 API 替换范围；仅计划，未实施。 |
| [2026-10-07-material-processing.md](2026-10-07-material-processing.md) | material processing相关阶段计划；结论仅限文件注明的日期与范围。 |
| [2026-10-07-workflow-mvp.md](2026-10-07-workflow-mvp.md) | workflow mvp相关阶段计划；结论仅限文件注明的日期与范围。 |
| [2026-10-08-answer-input-and-score-contract.md](2026-10-08-answer-input-and-score-contract.md) | answer input and score contract相关阶段计划；结论仅限文件注明的日期与范围。 |
| [2026-10-08-independent-modules.md](2026-10-08-independent-modules.md) | independent modules相关阶段计划；结论仅限文件注明的日期与范围。 |
| [2026-10-08-mvp-completion.md](2026-10-08-mvp-completion.md) | mvp completion相关阶段计划；结论仅限文件注明的日期与范围。 |
| [2026-10-08-mvp-remaining-work.md](2026-10-08-mvp-remaining-work.md) | mvp remaining work相关阶段计划；结论仅限文件注明的日期与范围。 |
| [2026-10-08-phase-four-independent-modules.md](2026-10-08-phase-four-independent-modules.md) | phase four independent modules相关阶段计划；结论仅限文件注明的日期与范围。 |
| [2026-10-08-priority-remediation.md](2026-10-08-priority-remediation.md) | priority remediation相关阶段计划；结论仅限文件注明的日期与范围。 |
| [2026-10-08-qwen-independent-integration.md](2026-10-08-qwen-independent-integration.md) | qwen independent integration相关阶段计划；结论仅限文件注明的日期与范围。 |
| [2026-10-08-qwen-main-flow-handoff.md](2026-10-08-qwen-main-flow-handoff.md) | qwen main flow handoff相关阶段计划；结论仅限文件注明的日期与范围。 |
| [2026-10-08-revision-loop-c.md](2026-10-08-revision-loop-c.md) | revision loop c相关阶段计划；结论仅限文件注明的日期与范围。 |
| [2026-10-08-step-four-authoring.md](2026-10-08-step-four-authoring.md) | step four authoring相关阶段计划；结论仅限文件注明的日期与范围。 |
| [2026-10-09-backend-logging-design.md](2026-10-09-backend-logging-design.md) | backend logging design相关阶段计划；结论仅限文件注明的日期与范围。 |
| [2026-10-09-project-wide-comments-and-folder-guides.md](2026-10-09-project-wide-comments-and-folder-guides.md) | project wide comments and folder guides相关阶段计划；结论仅限文件注明的日期与范围。 |

- [步骤汇总性能优化](2026-10-11-step-summary-performance.md)：只收窄作答与评分汇总读取，成果不处理；47 项定向测试通过，真实数据库性能未测量。

- [项目审查修复计划](2026-10-11-audit-remediation.md)：四项确认缺陷及两项条件性风险的最小修复；实现与静态差异检查已完成，未运行测试或数据库验收。
