<!-- 文件职责：索引按日期和范围保存的验证记录，并标明其历史证据属性。 -->
# 历史证据目录

本目录保存当时运行、接口或人工核查产生的证据。它们只说明记录时的范围，不代表当前数据库、服务、模型或浏览器状态。JSON、图像等不可注释文件按下表逐项登记；除非有明确复核记录，不修改或重生成旧证据。

| 文件 | 格式 | 用途 |
| --- | --- | --- |
| [2026-10-18-material-library-reader.md](2026-10-18-material-library-reader.md) | Markdown | 材料库逐文件阅读、对应版本对照、题目归档汇总、共用设置及DOCX中文/表格预览核对；只使用合成数据。 |
| 2026-10-18-material-library-original.png、2026-10-18-material-library-compare.png、2026-10-18-material-library-usage.png | PNG | 上述界面核对的浏览器截图，由browser-skill生成；只包含合成样张，不手工改图。 |
| [2026-10-14-material-question-workbench.md](2026-10-14-material-question-workbench.md) | Markdown | 合成 DOCX 的材料包一对多题目、标签冻结、版本快照和 101 题分页验收；明确未运行的模型与归档边界。 |
| [2026-10-13-redaction-output-validation-audit.md](2026-10-13-redaction-output-validation-audit.md) | Markdown | 脱敏输出校验取舍、题目6最近失败的日志证据边界、v14 扁平协议及161项定向测试；未完成真实模型整卷验收。 |
| [2026-10-11-cli-pipeline-and-lightweight-wait.md](2026-10-11-cli-pipeline-and-lightweight-wait.md) | Markdown | 同批逐题推进、轻量等待、一秒轮询；38项定向验证通过，完整路由集11项失败的临时基线对照及真实运行验收边界。 |
| [2026-10-11-question1-workflow-live-run.md](2026-10-11-question1-workflow-live-run.md) | Markdown | 题目1隔离副本七步及Excel真实跑通；227项定向单测，记录评分解析、归档查询与跨worktree存储问题及验收边界。 |
| [2026-10-11-workflow-cli-skill.md](2026-10-11-workflow-cli-skill.md) | Markdown | CLI/流程Skill实施、定向单测与类型检查、题目1真实归档末步；未重跑前序模型步骤，未对整个项目生成Excel。 |
| [2026-10-11-workflow-api-inventory.md](2026-10-11-workflow-api-inventory.md) | Markdown | 从材料入库到单题归档/项目导出的步骤、查询与派发接口、异步 worker 契约及当前领域 CLI 缺口；仅为当前工作树静态核查。 |
| [2026-10-10-fresh-authoring-alignment.md](2026-10-10-fresh-authoring-alignment.md) | Markdown | 普通出题从零生成、75项定向测试和真实工具验证；注明数据库53000及正式入库验收缺口。 |
| [2026-10-11-authoring-to-scoring-preflight.md](2026-10-11-authoring-to-scoring-preflight.md) | Markdown | 题目2–6、8正式全流程测试前置核查；记录 API/worker 早于当前源码修改启动的阻断，因此未派发本轮任务。 |
| [2026-10-11-backend-authoring-to-scoring-run.md](2026-10-11-backend-authoring-to-scoring-run.md) | Markdown | 题目2–6、8经正式后端 API/worker 出题、作答、评分与达标判定的完整运行记录；含中途派发修复、Codex 调用观察、分数及桌面对照限制。 |
| [2026-10-08-codex-default-settings.md](2026-10-08-codex-default-settings.md) | Markdown | 人工记录的调查或验收说明；结论仅限文件注明的日期与范围。 |
| [2026-10-08-current-ocr-audit.json](2026-10-08-current-ocr-audit.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [2026-10-08-current-ocr-audit.md](2026-10-08-current-ocr-audit.md) | Markdown | 人工记录的调查或验收说明；结论仅限文件注明的日期与范围。 |
| [2026-10-08-glm-ocr-comparison.json](2026-10-08-glm-ocr-comparison.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [2026-10-08-glm-ocr-comparison.md](2026-10-08-glm-ocr-comparison.md) | Markdown | 人工记录的调查或验收说明；结论仅限文件注明的日期与范围。 |
| [2026-10-08-glm-ocr-folder-review.json](2026-10-08-glm-ocr-folder-review.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [2026-10-08-glm-ocr-folder-trial.json](2026-10-08-glm-ocr-folder-trial.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [2026-10-08-glm-ocr-quality.json](2026-10-08-glm-ocr-quality.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [2026-10-08-glm-ocr-question-folder-trial.md](2026-10-08-glm-ocr-question-folder-trial.md) | Markdown | 人工记录的调查或验收说明；结论仅限文件注明的日期与范围。 |
| [2026-10-08-inference-key-check.json](2026-10-08-inference-key-check.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [2026-10-08-ocr-diagnosis.md](2026-10-08-ocr-diagnosis.md) | Markdown | 人工记录的调查或验收说明；结论仅限文件注明的日期与范围。 |
| [2026-10-08-ocr-high-quality.json](2026-10-08-ocr-high-quality.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [2026-10-08-ocr-low-quality.json](2026-10-08-ocr-low-quality.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [2026-10-08-ocr-speed-quality.json](2026-10-08-ocr-speed-quality.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [2026-10-08-openrouter-adapter-smoke.json](2026-10-08-openrouter-adapter-smoke.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [2026-10-08-openrouter-model-smoke.json](2026-10-08-openrouter-model-smoke.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [2026-10-08-openrouter-quickstart-cli.json](2026-10-08-openrouter-quickstart-cli.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [2026-10-08-question3-ocr-retry.json](2026-10-08-question3-ocr-retry.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [2026-10-08-real-question-folders.json](2026-10-08-real-question-folders.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [2026-10-08-real-question-folders.md](2026-10-08-real-question-folders.md) | Markdown | 人工记录的调查或验收说明；结论仅限文件注明的日期与范围。 |
| [2026-10-08-remediation-checks.json](2026-10-08-remediation-checks.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [2026-10-08-revision-loop-results.json](2026-10-08-revision-loop-results.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [2026-10-08-revision-provider-readiness.json](2026-10-08-revision-provider-readiness.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [2026-10-08-revision-real-answer-results.json](2026-10-08-revision-real-answer-results.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [2026-10-08-revision-real-author-results.json](2026-10-08-revision-real-author-results.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [2026-10-08-revision-real-grading-results.json](2026-10-08-revision-real-grading-results.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [2026-10-08-rule-loading.md](2026-10-08-rule-loading.md) | Markdown | 人工记录的调查或验收说明；结论仅限文件注明的日期与范围。 |
| [answer-flow-results.json](answer-flow-results.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [answer-input-and-score-validation.md](answer-input-and-score-validation.md) | Markdown | 人工记录的调查或验收说明；结论仅限文件注明的日期与范围。 |
| [authoring-flow-results.json](authoring-flow-results.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [codex-client-results.json](codex-client-results.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [codex-isolation-results.json](codex-isolation-results.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [direct-curl-ocr-low.json](direct-curl-ocr-low.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [direct-curl-ocr.json](direct-curl-ocr.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [directory-import.png](directory-import.png) | PNG 截图 | 当时界面或文件状态的截图；结论仅限文件注明的日期与范围。 |
| [domestic-adapters.md](domestic-adapters.md) | Markdown | 人工记录的调查或验收说明；结论仅限文件注明的日期与范围。 |
| [domestic-api-smoke-results.json](domestic-api-smoke-results.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [entity-page18-v8.json](entity-page18-v8.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [first-project-ai-override.json](first-project-ai-override.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [first-project-initialization.json](first-project-initialization.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [first-project-rule-freeze.json](first-project-rule-freeze.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [full-pdf-integration-results-v4.json](full-pdf-integration-results-v4.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [full-pdf-integration-results.json](full-pdf-integration-results.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [generated-cleanup-results.json](generated-cleanup-results.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [independent-modules-followup.md](independent-modules-followup.md) | Markdown | 人工记录的调查或验收说明；结论仅限文件注明的日期与范围。 |
| [independent-modules-integration.json](independent-modules-integration.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [independent-score-smoke-results.json](independent-score-smoke-results.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [input-version-results.json](input-version-results.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [integration-results.json](integration-results.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [material-input-versions.md](material-input-versions.md) | Markdown | 人工记录的调查或验收说明；结论仅限文件注明的日期与范围。 |
| [material-processing.md](material-processing.md) | Markdown | 人工记录的调查或验收说明；结论仅限文件注明的日期与范围。 |
| [ocr-page-probe.json](ocr-page-probe.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [pdf-and-wait-verification.md](pdf-and-wait-verification.md) | Markdown | 人工记录的调查或验收说明；结论仅限文件注明的日期与范围。 |
| [phase-four-independent-modules.md](phase-four-independent-modules.md) | Markdown | 人工记录的调查或验收说明；结论仅限文件注明的日期与范围。 |
| [phase-four-wiring.md](phase-four-wiring.md) | Markdown | 人工记录的调查或验收说明；结论仅限文件注明的日期与范围。 |
| [phase-one-workflow.jpg](phase-one-workflow.jpg) | JPEG 截图 | 当时界面或文件状态的截图；结论仅限文件注明的日期与范围。 |
| [phase-one.md](phase-one.md) | Markdown | 人工记录的调查或验收说明；结论仅限文件注明的日期与范围。 |
| [project-create-form.png](project-create-form.png) | PNG 截图 | 当时界面或文件状态的截图；结论仅限文件注明的日期与范围。 |
| [project-folder-results.json](project-folder-results.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [project-folder-workbench.md](project-folder-workbench.md) | Markdown | 人工记录的调查或验收说明；结论仅限文件注明的日期与范围。 |
| [project-skill-queue-results.json](project-skill-queue-results.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [project-skill-smoke-results.json](project-skill-smoke-results.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [project-steps.png](project-steps.png) | PNG 截图 | 当时界面或文件状态的截图；结论仅限文件注明的日期与范围。 |
| [qwen-api-smoke-results.json](qwen-api-smoke-results.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [qwen-independent-integration.md](qwen-independent-integration.md) | Markdown | 人工记录的调查或验收说明；结论仅限文件注明的日期与范围。 |
| [resource-monitor-results.json](resource-monitor-results.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [resource-monitor.md](resource-monitor.md) | Markdown | 人工记录的调查或验收说明；结论仅限文件注明的日期与范围。 |
| [rule-loading-results.json](rule-loading-results.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [rule-version-results.json](rule-version-results.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [rule-workspace-desktop.png](rule-workspace-desktop.png) | PNG 截图 | 当时界面或文件状态的截图；结论仅限文件注明的日期与范围。 |
| [rule-workspace-verification.md](rule-workspace-verification.md) | Markdown | 人工记录的调查或验收说明；结论仅限文件注明的日期与范围。 |
| [source-baseline.json](source-baseline.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |
| [unocss-px-results.json](unocss-px-results.json) | JSON | 结构化历史记录；结论仅限文件注明的日期与范围。 |

- [2026-10-18 豆包材料独立材料库真实流程测试](2026-10-18-doubao-library-real-flow.md)：复制配置与单份真实PDF；入库/提取成功，脱敏失败，后续未执行。
