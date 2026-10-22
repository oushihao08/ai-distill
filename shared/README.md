<!-- 文件职责：说明前后端共用的步骤身份、类型契约及其兼容要求。 -->
# 共享契约与步骤注册表

供前后端使用的轻量类型与步骤身份定义，不执行数据库查询或模型调用。

| 文件 | 职责 |
| --- | --- |
| `score.ts` | 后端达标与前端评分展示共用百分制换算；无效分数或满分返回空值 |
| `workflow-config.ts` | 项目阶段扩展配置及同步／异步钩子声明的结构校验；缺省不添加字段，不解释业务规则。钩子执行在 server/workflow-hooks.ts 和各阶段队列中完成，启用所需表仍需按环境核实 |
| `types.ts` | 项目材料模式、材料包／派生题目身份、材料、步骤、执行尝试与 API 返回类型，含跨项目成果库摘要 |
| `material-library.ts` | 独立材料库、项目加载关系、材料任务状态和题目材料来源的 DTO；不替代旧材料类型 |
| `material-preparation.ts` | CLI与服务端共用的精确编辑、分册范围和完整覆盖校验；不判断主体或法律内容，不访问数据库 |
| `workflow-results.ts` | 当前答案、评分、达标汇总的共享类型与 JSON 读取边界；不改变历史存储格式 |
| `step-prompts.ts` | 脱敏、出题、作答和评分的系统提示词；出题另提供固定通用规则，作者任务单独冻结该规则与项目可配置提示词 |
| `step-registry.ts` | 步骤 key、持久化 ordinal、可见 position、默认启用项和脱敏默认提示词 |
| `score.test.ts` | 新评分指标与原始分、否决项之间的百分制转换边界 |
| `step-registry.test.ts` | legacy、library_v1及旧材料包的可见步骤身份兼容 |
| `workflow-results.test.ts` | 答案/评分摘要读取时的形状校验与非法字段拒绝 |

`web/src/types/api.ts` 转出共享类型；后端材料接收、项目步骤汇总和执行器使用注册表。新增步骤应定义独立持久化身份，不重编号历史尝试。ordinal 2 仍用于旧目录流程的 PDF/DOCX 内部提取；3（旧规则绑定）和 10（旧独立审查）保留历史兼容；ordinal 4 为出题，七个可见步骤的位置为 1 至 7。

`workflow-results.ts` 定义当前作答、评分和达标摘要，并提供读取未知 JSON 的运行时边界函数；旧记录缺少可选字段时继续可读，不据此推断为成功。它只约束前后端对已有结果的读取，不添加数据库字段或改变 Agent 可见输入。

类型声明不代替服务端运行时校验；修改字段须检查 Hono 返回值、前端消费者和已有任务快照。页面状态名、步骤顺序与数据库序号是不同概念。

`types.ts` 共用 `ModelApiProvider` / `ModelApiConfig`（含 SiliconFlow），脱敏步骤配置支持嵌套 `api` 配置；`RedactionProgress` 只包含阶段、字段计数、批次与请求计数、期限和耗时统计，不含正文或模型配置；`Step.ready` 与 `Step.ready_reason` 由服务端统一计算并供逐题步骤表展示；`Project.workflow_count` 保留总数，`material_package_count` 与 `question_count` 分别供项目列表展示；`ProjectDetail.workflow_status` 是项目详情首屏共用的轻量步骤状态与已出题标记快照，供步骤摘要和题目表复用；`Project.question_tags` 是本期可选目录，`Workflow.question_tags` 是题目创建时的标签快照，旧 `target_level` 仍可读；项目 `Workflow` 的达标判定、逐模型分数及发布／导出状态用于达标题目表；`ResultLibraryItem` 包含跨项目达标题目的来源材料包 ID 与名称；`WorkflowDetail.material_package_questions` 仅在材料包详情列出未删除派生题目的轻量摘要，`source_material_package` 提供派生题目来源标题；新材料库项目显式携带 `material_backend/workspace_path`，新题私有 artifact 的 `attempt_id` 可空并由类型化 `question_material_origin` 绑定；密钥不得进入这些公开类型或配置。

`material-library.ts` 的 job 状态只描述持久化材料任务；`MaterialLibraryPackageSummary.material_uses` 是列表页当前分页的轻量使用账摘要，含主项目、所属期和状态，不含历史事件。排队资源、worker 租约、取消和来源校验由服务端实现，不能仅凭 DTO 推断任务已执行或结果可用于建题。

共享材料库 DTO 中，`MaterialUseRecord` 只承载单条使用关系的当前状态摘要；历史事件由 `MaterialUseEvent` 单独表示并按需读取。项目工作流列表可带 `library_package_id/name`，用于展示由共享材料包创建的题目来源；这不替代题目私有 `question_library_sources` 快照，也不改变旧 `source_workflow_id` 的兼容读取。

WorkflowDetail 的 artifacts 可带 filename，供逐附件脱敏 DOCX 下载链接显示文件名；不返回存储绝对路径。

`score.ts` 的 `evaluationPercentage()` 对 model_report_v1 直接使用明确的 evaluation_percent，空指标不回退至 raw_score；旧结果仍用 scorePercentage。workflow 配置的 `input_purpose` 只声明同步前置补充说明用途，不授权更改作答输入或核心成果。

`Material.redaction_mode` 由服务端附件详情返回，`model` 为默认；DOCX 的 `declared_redacted` 是操作者声明，前端需按当前附件 SHA-256 提交变更。

workflow-config.ts 的可选 content_contract=work_legal_v1 供出题阶段显式绑定内容结构，与评分 contract 分开；未提供时不增加默认键。

结果读取函数只做关键形状检查，并保留传入对象的其他字段；它们不是敏感字段过滤器，也不证明模型数量、来源版本或业务达标。输入隔离和达标校验由后端执行器及判断模块负责。

`redaction-templates.ts`维护模板身份、两种流程和默认代称提示词；`document-structure.ts`是共用结构类型和唯一文字投影，旧server/materials/pdf继续兼容导出；`prepared-structure.ts`校验字段内修改、结构分册和投影覆盖，不运行模型或存储。

`material-preparation.ts`提供CLI/HTTP共用计划入口校验与文字编辑/覆盖校验；入口身份校验不能代替数据库里的来源/模板绑定，也不证明模型识别的主体及分册判断正确。

`agent-material-plan.ts`定义Agent整包语义输出及编译器：生成稳定字段/块ID，展开已确认的固定主体映射，应用类型化遮盖，自动计算UTF-16和编辑后分册坐标，再调用原prepared-structure完整校验。`agent-material-plan.test.ts`仅用合成资料验证此契约。

`material-library.ts`同时定义三模式`MaterialProcessingMode`及兼容解析/来源映射/结果分类函数，供后端和页面共用。处理意图与original/redacted快照来源是不同层次：mask和aliases均冻结redacted，原文冻结original；执行后端不写进处理方式枚举。

`scan-noise.ts`识别同文件跨页重复的扫描时间戳签名、已证明的扫描号及连续页角码，返回精确删除范围；不处理表格/列表字段，不删除无上下文的业务数字或日期。编译器将这些范围合并进正式计划，再做原文/结构/完整覆盖校验；cleanScanNoisePages只生成显式预览副本，不改变冻结来源。其单元测试覆盖业务值保留与孤立时间戳不清理。
