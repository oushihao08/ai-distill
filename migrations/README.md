<!-- 文件职责：说明迁移文件的历史顺序、登记方式、影响范围与执行边界。 -->
# 数据库迁移

SQL 文件演进 `ai_distill` schema 的表、约束、索引和步骤布局。此目录不是可随意重放的初始化样例。

`server/migrate.ts` 在事务中获取 advisory lock，按文件名排序读取 `.sql`；以完整文件名查询 `schema_migrations`，只应用尚未登记的文件。两个 `006_*.sql` 是不同迁移，不能只按数字判断已执行。已登记文件不会因正文变化自动重跑，后续兼容修复应单独追加迁移。

| 迁移文件 | 演进内容 |
| --- | --- |
| `001_initial.sql` | 建立初始项目、规则、工作流、材料、步骤、尝试和产物表。 |
| `002_material_processing.sql` | 增加材料任务心跳、提取队列索引并启用历史提取步骤。 |
| `003_input_versions.sql` | 增加旧版题目来源标识与材料／尝试输入版本字段。 |
| `004_project_folders.sql` | 增加项目材料／skill 目录、来源清单、逻辑删除及项目步骤配置。 |
| `005_answer_queue.sql` | 启用模型作答步骤并建立队列索引。 |
| `006_rule_loading.sql` | 启用历史规则绑定步骤；不代表该步骤仍是当前可见流程。 |
| `006_score_queue.sql` | 启用独立评分步骤并建立队列索引；同编号文件按完整文件名分别登记。 |
| `007_project_skill_tasks.sql` | 建立项目 skill 生成尝试与持久化队列。 |
| `008_acceptance_reporting.sql` | 启用达标步骤并建立 API 价格目录、项目导出记录。 |
| `009_stale_exports.sql` | 为旧项目导出补充输入变化后的 `stale` 状态兼容。 |
| `010_authoring_queue.sql` | 启用出题步骤并建立等待／运行队列索引。 |
| `011_publication_step.sql` | 启用成果发布步骤；发布校验由服务端模块处理。 |
| `012_answer_model_registry.sql` | 建立系统作答模型目录及项目模型集合。 |
| `013_answer_model_config_snapshot.sql` | 将模型 provider／endpoint／model 固定到结构化配置快照。 |
| `014_decoupled_workflow_steps.sql` | 引入稳定步骤 key 与独立显示顺序，保留 ordinal 历史身份，建立旧项目步骤模板。 |
| `015_revision_chains.sql` | 建立后由 `029` 撤除的旧返修链、轮次及调用账本。 |
| `016_automation_control.sql` | 建立后由 `024` 撤除的旧自动运行批次、暂停及派发阻断结构。 |
| `017_openrouter_and_pending_threshold.sql` | 扩展旧模型供应商并允许项目最低分未配置。 |
| `018_database_text_artifacts.sql` | 为旧产物增加数据库正文及材料阶段索引。 |
| `019_ingestion_step_layout.sql` | 将 PDF 文本提取并入可见入库状态，保留内部 ordinal 2 和独立脱敏。 |
| `020_material_revision_stage.sql` | 兼容回填旧返修阶段字段及其约束；返修表随后由 `029` 移除。 |
| `021_system_codex_config.sql` | 建立系统 Codex 凭证目录登记，不保存凭证正文。 |
| `022_codex_default_settings.sql` | 增加系统默认 Codex 模型与推理强度。 |
| `023_project_codex_defaults.sql` | 增加项目级 Codex 默认设置字段。 |
| `024_remove_automation_control.sql` | **破坏性历史迁移**：删除旧自动运行表、函数和暂停字段；执行前须核对删除范围。 |
| `025_separate_authoring_review.sql` | 历史上拆分出题与独立审查步骤；ordinal 10 仅保留历史身份，不是当前可见步骤。 |
| `026_database_integrity.sql` | 补齐旧步骤位置、工作流归属复合外键和外键索引。 |
| `027_remove_material_versions.sql` | **破坏性历史迁移**：移除材料版本字段并重置受影响的当前任务状态，保留原件及历史；须与对应代码版本一起切换。 |
| `028_remove_unused_design_tables.sql` | 删除已停用 API 价格目录及项目步骤模板表。 |
| `029_remove_revision_chains.sql` | 删除旧返修链、轮次、调用账本及尝试关联字段。 |
| `030_project_phase_skill_sharing.sql` | 增加主项目／期次名称并回填有明确证据的第五期身份与共享 skill 路径。 |
| `031_project_period_root.sql` | 将有明确身份的第五期材料根目录和工作流来源路径迁至主项目期次目录。 |
| `032_workflow_authoring_direction.sql` | 为题目增加可空的出题方向字段。 |
| `033_workflow_hooks.sql` | 建立工作流阶段钩子及主操作检查点；由当前钩子模块按需使用。 |
| `034_remote_material_operations.sql` | 增加本机／服务器执行归属和可恢复的远程材料组合操作记录。 |
| `035_material_package_questions.sql` | 增加旧目录一题与材料包多题模式、派生题身份及来源绑定。 |
| `036_system_step_prompts.sql` | 增加脱敏、出题、作答和评分的系统提示词配置字段。 |
| `037_project_question_tags.sql` | 增加项目可选出题标签及题目创建时的标签快照。 |
| `038_docx_redaction_declaration.sql` | 增加材料脱敏方式，默认模型脱敏并允许显式声明已脱敏 DOCX。 |
| `039_remote_operation_compatibility.sql` | 为早期远程操作记录补齐可空配置摘要和领取令牌字段。 |
| `040_codex_answer_provider.sql` | 允许作答模型目录登记本机 Codex provider。 |
| `041_siliconflow_answer_provider.sql` | 允许作答模型目录登记 SiliconFlow provider。 |
| `042_shared_material_library.sql` | 建立全局材料库包／不可变 revision／处理任务／期次加载关系和题目来源快照；不迁移旧材料。 |
| `043_publication_provenance.sql` | 建立不可变归档／撤回事件，保留提交来源及历史身份。 |
| `044_legacy_projects_library_packages.sql` | 允许 legacy 项目加载全局材料包；新题按各自来源快照区分新旧读取链。 |
| `045_project_groups_material_use.sql` | 建立主项目与期次关系、跨期永久材料使用账、提交／返修事件及旧加载来源映射；不改题目结果。 |
| `046_question_material_source_mode.sql` | 允许新题冻结 `redacted` 或 `original` 来源模式；默认脱敏，按完整脱敏或提取快照校验来源。 |

执行前核对目标数据库、已登记文件和全部未执行 SQL。`024_remove_automation_control.sql` 删除旧自动批次、成员、阻断表、派发函数及项目暂停字段，不能为修复 Codex 设置顺便执行。数据库迁移、服务重启和真实接口核对是不同操作，均遵守根 [AGENTS.md](../AGENTS.md) 的授权约束。

不能从本目录存在文件推断当前数据库已应用它。不要删除旧文件、改名或重新编号来“整理”历史。

`047_local_execution_dispatch.sql`新增执行器归属/代次登记和五类任务UPDATE保护；不迁移历史记录、不自动认领旧队列。配套客户端以实际PG application_name声明执行归属。启用和切换见`server/execution-queue/README.md`。
