<!-- 文件职责：说明前后端共用的步骤身份、类型契约及其兼容要求。 -->
# 共享契约与步骤注册表

供前后端使用的轻量类型与步骤身份定义，不执行数据库查询或模型调用。

| 文件 | 职责 |
| --- | --- |
| `score.ts` | 后端达标与前端评分展示共用百分制换算；无效分数或满分返回空值 |
| `workflow-config.ts` | 项目阶段扩展配置及同步／异步钩子声明的结构校验；缺省不添加字段，不解释业务规则。钩子执行及阶段接入仍在实施 |
| `types.ts` | 项目材料模式、材料包／派生题目身份、材料、步骤、执行尝试与 API 返回类型，含跨项目成果库摘要 |
| `workflow-results.ts` | 当前答案、评分、达标汇总的共享类型与 JSON 读取边界；不改变历史存储格式 |
| `step-prompts.ts` | 脱敏、出题、作答和评分的系统级提示词默认；新建项目复制快照，项目提示词和冻结任务各自独立 |
| `step-registry.ts` | 步骤 key、持久化 ordinal、可见 position、默认启用项和脱敏默认提示词 |

`web/src/types/api.ts` 转出共享类型；后端材料接收、项目步骤汇总和执行器使用注册表。新增步骤应定义独立持久化身份，不重编号历史尝试。ordinal 2（PDF/DOCX 内部提取）、3（旧规则绑定）和 10（旧独立审查）仅用于历史兼容；ordinal 4 为出题，七个可见步骤的位置为 1 至 7。

`workflow-results.ts` 定义当前作答、评分和达标摘要，并提供读取未知 JSON 的运行时边界函数；旧记录缺少可选字段时继续可读，不据此推断为成功。它只约束前后端对已有结果的读取，不添加数据库字段或改变 Agent 可见输入。

类型声明不代替服务端运行时校验；修改字段须检查 Hono 返回值、前端消费者和已有任务快照。页面状态名、步骤顺序与数据库序号是不同概念。

`types.ts` 共用 `ModelApiProvider` / `ModelApiConfig`，脱敏步骤配置支持嵌套 `api` 配置；`RedactionProgress` 只包含阶段、字段计数、批次与请求计数、期限和耗时统计，不含正文或模型配置；`Step.ready` 与 `Step.ready_reason` 由服务端统一计算并供逐题步骤表展示；`Project.workflow_count` 保留总数，`material_package_count` 与 `question_count` 分别供项目列表展示；`Project.question_tags` 是本期可选目录，`Workflow.question_tags` 是题目创建时的标签快照，旧 `target_level` 仍可读；项目 `Workflow` 的达标判定、逐模型分数及发布／导出状态用于达标题目表；`ResultLibraryItem` 包含跨项目达标题目的来源材料包 ID 与名称；`WorkflowDetail.material_package_questions` 仅在材料包详情列出未删除派生题目的轻量摘要，`source_material_package` 提供派生题目来源标题；密钥不得进入这些公开类型或配置。

WorkflowDetail 的 artifacts 可带 filename，供逐附件脱敏 DOCX 下载链接显示文件名；不返回存储绝对路径。

`score.ts` 的 `evaluationPercentage()` 对 model_report_v1 直接使用明确的 evaluation_percent，空指标不回退至 raw_score；旧结果仍用 scorePercentage。workflow 配置的 `input_purpose` 只声明同步前置补充说明用途，不授权更改作答输入或核心成果。

`Material.redaction_mode` 由服务端附件详情返回，`model` 为默认；DOCX 的 `declared_redacted` 是操作者声明，前端需按当前附件 SHA-256 提交变更。

workflow-config.ts 的可选 content_contract=work_legal_v1 供出题阶段显式绑定内容结构，与评分 contract 分开；未提供时不增加默认键。
