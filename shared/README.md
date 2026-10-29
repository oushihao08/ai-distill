<!-- 文件职责：说明前后端共用的步骤身份、类型契约及其兼容要求。 -->
# 共享契约与步骤注册表

供前后端使用的轻量类型与步骤身份定义，不执行数据库查询或模型调用。

| 文件 | 职责 |
| --- | --- |
| `score.ts` | 后端达标与前端评分展示共用百分制换算；无效分数或满分返回空值 |
| `workflow-config.ts` | 项目阶段扩展配置及旧钩子声明的结构校验（历史 async 兼容读取，新执行统一同步）；缺省不添加字段，不解释业务规则。钩子执行由 server/lifecycle 统一接入，启用所需表仍需按环境核实 |
| `types.ts` | 项目材料模式、材料包／派生题目身份、材料、步骤、执行尝试与 API 返回类型，含跨项目成果库摘要 |
| `material-library.ts` | 独立材料库、项目加载关系、材料任务状态和题目材料来源的 DTO；不替代旧材料类型 |
| `material-markup.ts` | 材料文本去HTML/XML标签、多层实体及文字转义的精确编辑；保留标签内正文、法规名称与比较符号，不处理DOCX |
| `material-preparation.ts` | CLI与服务端共用的精确编辑、分册范围和完整覆盖校验；不判断主体或法律内容，不访问数据库 |
| `workflow-results.ts` | 当前答案、评分、达标汇总的共享类型与 JSON 读取边界；不改变历史存储格式 |
| `step-prompts.ts` | 脱敏、出题、作答和评分的系统提示词；出题另提供固定通用规则，作者任务单独冻结该规则与项目可配置提示词 |
| `step-registry.ts` | 步骤 key、持久化 ordinal、可见 position、默认启用项和脱敏默认提示词 |
| `score.test.ts` | 新评分指标与原始分、否决项之间的百分制转换边界 |
| `step-registry.test.ts` | legacy、library_v1及旧材料包的可见步骤身份兼容 |
| `workflow-results.test.ts` | 答案/评分摘要读取时的形状校验与非法字段拒绝 |
| `agent-text-material-plan.test.ts` | 新ID文本字段归属、原ID复用、空行/合并单元格、跨文件隔离及非法返回ID边界；不调用模型/数据库 |

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

`redaction-templates.ts`维护模板身份、Agent化名流程和默认代称提示词；`document-structure.ts`是共用结构类型和唯一文字投影，旧server/materials/pdf继续兼容导出；`prepared-structure.ts`通过`documentBlockFields()`唯一枚举段落、列表、表格单元格/表题/脚注的字段路径和精确坐标（含空行分隔符），供脱敏、格式清理和结构回填共用；校验字段内修改、结构分册和投影覆盖，不运行模型或存储。

`material-preparation.ts`提供CLI/HTTP共用计划入口校验与文字编辑/覆盖校验；入口身份校验不能代替数据库里的来源/模板绑定，也不证明模型识别的主体及分册判断正确。

`agent-material-plan.ts`以`AGENT_TEXT_REDACTION_PROTOCOL=id-text-v2`定义材料库新脱敏契约：模型仅收发完整`{id,text}`字段列表，附带分册范围与疑点；`compileAgentTextMaterialPlan()`校验新格式和完整ID集合，按冻结字段映射回填原结构并复用精确计划/分册编译。新字段ID沿用带文件/页作用域的原块ID并追加字段路径；缺失/重复块ID仅在定位键中补冻结位置，不修改原结构ID或按文本匹配。`compileAgentMaterialPlan()`继续兼容历史entities/edits计划及v1位置ID重验；原块ID重复的歧义旧映射明确拒绝。确定扫描垃圾与格式残留仍走共用清理规则；ID/结构校验不代替脱敏语义验收。任务冻结、续作及发布说明见[材料库](../server/material-library/README.md#agent材料执行与验收)。





精确编辑重叠仍以`agent_edit_overlap`拒绝；异常的`validation_details`仅包含冲突字段ID、原计划编辑数组的零起始序号及字段内坐标，供Agent私有校验器定位修正，不包含主体原称、号码或正文，不改变发布标准。

文书标题内容由Agent按本次模板生成；编译器不做标题主体原称匹配，也不增加标题号码等敏感信息检查。显示标题不受非空、100字或冒号等文件名限制；空标题使用稳定序号，输出文件名独立净化并以序号防重，结构与覆盖校验保留。


`material-library.ts`区分当前可保存两模式`NewMaterialProcessingMode`与含历史mask的`MaterialProcessingMode`及兼容解析/来源映射/结果分类函数，供后端和页面共用。处理意图与original/redacted快照来源是不同层次：mask和aliases均冻结redacted，原文冻结original；执行后端不写进处理方式枚举。

`scan-noise.ts`通过`findScanNoiseEdits()`及`cleanScanNoisePages()`提供结构化清理：将明确OCR占位标记、数字前缀扫描时间戳、扫描/打印时间标签替换为空串；普通独立数字行（包括`-22-`）默认保留，保留换行；支持大小写和常见空格/下划线变体。固定列表包括NO TEXT、NO TEXT DETECTED、NO TEXT FOUND、QR Code、Image、Barcode、Bar Code、UNREADABLE等，不泛删`[证据1]`等正文。数字行不作用于表格/列表/公式/代码块；已被Agent编辑覆盖的纯数字候选不重复清理；页角数字仍按扫描证据处理，不能把技术通过视为业务数字已全面核验。普通正文日期、带单位金额、小数和`1、`条目不匹配。

`findScanNoiseEdits()`复用`materialMarkupEdits()`清除材料文本中的标签外壳（含中文/未知/错配标签）及多层实体残留，保留标签内正文；法规名称尖括号转书名号，数字比较符号保留。标签与实体使用局部精确编辑，不以整字段替换覆盖化名或号码遮盖。它将清理和确定格式还原转为原文精确坐标，供Agent计划编译并验证文书覆盖；`cleanScanNoisePages()`按结构字段生成副本，供新提取正文发布前复用并重建正文/索引。两者不改传入结构或既有发布结果；提取发布的原始OCR与编辑审计由材料库执行器保存。普通数字行保留；C类角码需处于页边界且同文件已有重复扫描签名证据，其他数字需跨页页角证据。条码编号只在“数字+[Barcode]”独占同一字段行时一起清理，业务编号与标记相邻不等于垃圾。文字格式还原覆盖Unicode、星号/下划线/引号等转义、字面换行/制表符及真实材料出现的LaTeX角度/百分号排版；不反推OCR本来应是什么数字。Windows路径只规范分隔符，代码和公式保留其语法转义。实体支持缺分号的常见残留，XML声明、命名空间标签和CDATA外壳清除，内部正文保留。测试覆盖坐标、幂等、单位/日期、表格和映射后编号保留。

API供应商标识唯一枚举为types.ts的MODEL_API_PROVIDERS；钩子配置和安全日志复用此值集合，入口仍独立校验端点、密钥和模型能力。

`project-creation.ts`由服务端只读回执接口复用的创建参数匹配器（目录先由服务端规范化），按主项目/期号查候选后严格比较关键参数，冲突不冒记成功；无网络和写入副作用。

`execution-state.ts`是本机/其他执行端/未归属的轻量步骤投影契约，`revision-advice.ts`是手动建议历史与当前有效标记契约；不替代共享题目/答案/评分结果，不携带租约、检查点或凭证。

`Attempt.heartbeat_at`为可选诊断元数据；当前attempt状态HTTP返回数据库最后心跳，旧详情/历史读取可能不提供此字段。它不改变完成/成功判据，也不授权失租重派。

固定噪声清理以单个结构字段为边界；相邻表格单元格或列表项不拼接成扫描时间戳。一个字段内明确的扫描签名仍清理，跨字段的独立编号与普通日期保留，避免生成无法应用的跨单元格编辑。

MaterialLibraryJob可附加execution，复用StepExecution表达归属和本机状态；不替换业务status。

`redaction-templates.ts`的可执行workflow仅有codex_plan；旧mask/field_mapping模板解析与模型执行已删除。material-library.ts保留mask字面量仅识别历史配置/快照，不能据此派发或恢复旧模型任务。

Agent计划中的unresolved仅保存语义疑点，不因blocking标记或缺少身份映射拒绝技术发布。编译器不猜测姓名、号码、地址残留，不以化名风格、原文同词、机构关键词、金额/日期形态或电话字符白名单否决。主体ID、替换字符串、精确原文位置、编辑冲突、完整覆盖及结构投影仍校验；地址前缀必须属于原文，允许保留整个片段。文书可跨文件，来源身份不变。此处通过只证明计划可执行，不证明脱敏无遗漏。

`material-preparation-result.ts`定义真实文书、逐份摘要/可见标记、多个可支持方向—场景—交付组合及模型/DOCX可见正文投影；它含服务端SHA-256实现，不可从浏览器运行时导入。纯计数函数位于`material-preparation-counts.ts`，可由前端安全使用。建题冻结来源仍保留全文，人工预览不裁剪；含整理结果时出题、作答和DOCX只消费可见文书，评分复用作答时冻结的输入。最终选择的交付成果保存在出题尝试JSON结果；方向+场景参考索引冲突不拦出题；主组合及`additional_combinations`均由尝试JSON保留，旧单组合兼容。新任务由`compileFixedPreparation()`固定来源ID、标题、顺序及全部正文，Agent只返回描述和现有记录类别，不拆合材料；全空记录不计完整文书。旧块级编译器仅保留兼容。逐份描述补齐后再生成总摘要及候选组合，总摘要不维护处理计数，程序统一统计。旧记录缺文书类型时仅能报告整理条目数，不能推断真实份数。旧`selected-material-index-v1`仅为历史快照只读校验。服务端行为唯一说明见[材料库](../server/material-library/README.md#材料整理与使用范围)。

单次材料整理协议由MATERIAL_PREPARATION_SINGLE_SCHEMA定义，仅允许元数据和候选组合，不返回正文边界或完整文书分类；compileFixedPreparation的inheritKindsOnly用于新任务继承来源类别。visiblePreparationContext保留基于可见材料生成的总摘要。

模型正文统一入口为document-structure.ts的documentPagesToModelText：从blocks或structure生成带页码、标题、列表和HTML表格的正文，保留rowspan/colspan、表题与脚注，转义单元格文字；无结构的历史页保留text。材料整理直接内联该正文；question-materials.ts在出题及新作答的模型附件投影中共用该方法，评分继续读取作答冻结的同一正文。documentBlocksToText仍是旧稳定投影，用于摘要指纹、脱敏坐标和结构校验，不改变历史字节；原结构与DOCX排版不变。
