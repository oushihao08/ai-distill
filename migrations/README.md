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

`060_explicit_cross_phase_question_reuse.sql`给加载关系增加原期题目与新方向的不可变记录，并将材料使用账触发器的跨期例外限定为同主项目、同包、原期成功题目；普通加载仍拒绝跨期复用。它不回填或迁移既有加载关系。

`047_local_execution_dispatch.sql`新增执行器归属/代次登记和五类任务UPDATE保护；不迁移历史记录、不自动认领旧队列。配套客户端以实际PG application_name声明执行归属。启用和切换见`server/execution-queue/README.md`。

`048_system_authoring_defaults.sql`为现有系统配置增加出题专用默认JSON字段，仅供新期复制，不回写既有数据。定向执行入口见运行脚本说明。

`050_manual_revision_advice.sql`新增独立手动建议任务表、活动防重索引及advice归属保护；不改步骤ordinal、题目、作答、评分或自动推进。未应用时建议入口明确不可用，原出题可继续。须按目标环境核实迁移，不从隔离库验收推断业务库已应用。

`052_active_phase_number_unique.sql`将主项目期号唯一性限制在未删除期次；已删除期次仍保留历史行，但不再阻止以相同期号重新创建。迁移只重建索引，不改项目或工作流记录。

`051_optional_material_preparation.sql`增加可选prepare任务及单张结果表，并将prepare排除出提取/脱敏revision互斥索引；不回填历史、不新增主流程门禁。只在明确目标环境后按完整文件名应用，不为该文件盲跑全部未登记迁移。源码/隔离测试不代表业务库已部署。

`053_question_material_scope_uses.sql`保存新建题目最终采用的方向+场景组合，唯一范围为期次项目；不回填无法可靠结构化的历史题。与051一并服务于可选材料整理信息的出题输入和重复组合保护；不得单独推断业务环境已应用。

- `054_atomic_library_import.sql`：新导入任务成功前不绑定材料包/版本，发布事务一次性落全部正式数据；新包/版本/原件采用延迟成功提取约束。只准备迁移文件不代表目标库已应用；不清理历史，不运行全量迁移补此文件。需协调更新API和worker。
- `055_repair_atomic_import_constraints.sql`：重新部署054的包/版本与原件延迟完整性函数，为拒绝回执附安全约束名；不改表、不回写或重试历史任务。定向应用入口为 `scripts/runtime/apply-atomic-import-constraint-migration.ts --apply`，发现其他待迁移时拒绝执行。
- `056_split_atomic_import_constraint_triggers.sql`：将包、版本、文件和原件blob的延迟完整性检查拆成独立触发器函数，不再依赖`TG_TABLE_NAME`分流；校验条件及原子回滚边界不变。
- `057_finalize_atomic_import_on_job_success.sql`：移除依赖后续任务成功状态的包/版本/文件插入循环触发器，由提取任务成功事件统一核对版本ready、当前版本、文件数和提取正文数；任一不完整仍整个事务回滚。
- `058_remove_document_insert_success_cycle.sql`：移除正文插入时反查后续任务成功状态的循环触发器；正文数已由057的任务成功门禁统一校验，数量不完整仍回滚。
- `059_allow_atomic_revision_seal.sql`：原子导入版本不再要求不存在的独立intake任务；其ready状态、当前版本、文件数和正文数由057的提取任务成功门禁核对，普通历史版本仍保留intake校验。
- `061_library_load_eligibility.sql`：按revision、成功提取任务及评估算法版本保存完整材料合并后的DOCX估算页数和生成的加载资格字段；不回填、删除或改写既有期次关系。只有迁移与新版API均在目标环境生效后，新加载、选版和恢复门槛才可用。
- `062_prepare_api_executor.sql`：仅允许可选材料整理任务选择本机API执行池；原Agent整理及其他材料任务约束不变。应用后新API整理任务才能成功入队。
- `063_library_image_review.sql`：给材料库文件增加逐图价值判断标记，历史文件默认 `false`；与可选保图入库和材料整理配套，不回填或修改历史提取结果。需核实目标库已应用且新版 API/worker 同时加载后才启用新参数。
- `064_web_agent_lane.sql`：为网页Agent（DeepSeek/Gemini）独立通道放宽`execution_dispatches.lane`，并允许材料库`prepare`任务使用`executor_kind='web'`（仍仅local目标）；`redact` 额外允许本机目标的 `web`，仅供离线作业台（人工网页操作后交回），自动网页脱敏由应用层拒绝。同时重建042列内联的`library_jobs_executor_kind_check`与`library_jobs_executor_target`，不回填历史任务。仅写入文件，未对任何库应用；需核实目标库后按完整文件名定向应用，且新版API/worker同时加载后才启用web派发。
