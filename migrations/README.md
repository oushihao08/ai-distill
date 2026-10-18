<!-- 文件职责：说明迁移文件的历史顺序、登记方式、影响范围与执行边界。 -->
# 数据库迁移

SQL 文件演进 `ai_distill` schema 的表、约束、索引和步骤布局。此目录不是可随意重放的初始化样例。

`server/migrate.ts` 在事务中获取 advisory lock，按文件名排序读取 `.sql`；以完整文件名查询 `schema_migrations`，只应用尚未登记的文件。两个 `006_*.sql` 是不同迁移，不能只按数字判断已执行。已登记文件不会因正文变化自动重跑，后续兼容修复应单独追加迁移。

| 文件范围 | 演进内容 |
| --- | --- |
| `001`–`004` | 项目／工作流／材料／尝试／产物、心跳、输入版本、目录及项目步骤配置 |
| `005`–`007` | 作答、内部规则绑定、评分队列及项目 skill 任务 |
| `008`–`011` | 达标、API 价格、项目导出、旧导出标识、出题队列与发布步骤 |
| `012`–`013`、`017` | 系统模型目录、项目模型集合、配置快照、OpenRouter 与待配置分数 |
| `014`、`019`、`025` | 稳定 step key 与显示顺序；入库包含内部 PDF 提取，脱敏独立显示；ordinal 10 曾用于独立审查，当前仅保留历史数据 |
| `027_remove_material_versions.sql` | 撤除工作流、附件、执行尝试、返修链的材料版本字段及导出版本映射；按旧归属标记历史附件移除，保留原件和历史，取消活动任务并重置脱敏及后续当前状态。须停旧进程后与新代码一起切换。 |
| `026` | 修正项目步骤模板位置；用复合外键约束附件、返修链／轮次／尝试的工作流归属，并补齐缺失的外键索引 |
| `015`、`020` | 返修链、轮次、调用账本和材料返修阶段兼容修复 |
| `016`、`024` | 历史自动运行控制建表及后续撤除；两者保留迁移历史 |
| `018` | 数据库文本产物正文 |
| `021`–`023` | Codex 凭证目录配置、系统默认与项目默认模型／推理强度 |
| `028_remove_unused_design_tables.sql` | 删除已停用的 API 价格目录和项目步骤模板表；当前代码不读写，价格表为空，项目步骤使用稳定注册表。 |
| `029_remove_revision_chains.sql` | 删除返修链、轮次、调用预算表及 `step_attempts.revision_round_id`；应用已不再运行返修流程，执行前确认表为空。 |
| `030_project_phase_skill_sharing.sql` | 为期次工作流记录主项目名与期数；明确将已知旧项目“豆包高经济价值 - 第五期”（含无空格别名）映射到主项目“豆包高经济价值／第五期”，并把仓库内旧 skill 路径改为主项目级 `projects/豆包高经济价值/skill`；其他旧项目仍按原名独立回填且期数留空；移除 skill 路径唯一索引以支持共享。应用状态以 `schema_migrations` 为准。 |
| `032_workflow_authoring_direction.sql` | 为单题工作流增加可空的出题方向字段；旧题默认无方向，不改历史尝试。 |
| `033_workflow_hooks.sql` | 新增阶段钩子记录及主操作检查点；与原尝试复合外键绑定，删除尝试时级联清理；不改 ordinal 或历史结果。代码未启用钩子时不查询此表；真实迁移须单独审阅并授权。 |
| `034_remote_material_operations.sql` | 给尝试增加默认 `local` 的执行归属，并保存远程入库／脱敏组合操作及其阶段、输入指纹和 attempt 引用；旧任务无需改写。部署远程材料 worker 前必须应用，不能因本文件存在就假设数据库已更新。 |
| `035_material_package_questions.sql` | 项目材料模式和工作流身份；派生题目记录同项目材料包、来源成功脱敏尝试及正文哈希，并以复合外键锁定来源。旧项目默认 `question_folders`；此文件不清理业务数据，也不表示目标数据库已迁移。 |
| `036_system_step_prompts.sql` | 在系统配置中保存脱敏、出题、作答和独立评分的系统级提示词；新建项目复制当时的提示词快照，旧项目和旧任务不被系统默认变更回写。 |
| `037_project_question_tags.sql` | 项目保存本期可选出题标签，题目保存创建时已选标签快照；将本项目历史 `target_level` 值加入可选目录，不改写旧题或旧任务。执行状态以目标库 `schema_migrations` 为准。 |
| `038_docx_redaction_declaration.sql` | 材料增加默认 `model` 的脱敏方式字段；DOCX 可按附件指纹显式声明 `declared_redacted`，既有材料保持默认。新代码部署前需单独核对并应用。 |
| `039_remote_operation_compatibility.sql` | 补齐早期已登记 034 的部署缺少的 `redaction_config_digest` 与 `claim_token`；只新增可空字段，保留已有记录。 |
| `040_codex_answer_provider.sql` | 允许作答模型目录真实登记本机 Codex Agent provider；不变更现有作答模型或尝试。 |
| `041_siliconflow_answer_provider.sql` | 允许作答模型目录登记 SiliconFlow API provider；不变更现有作答模型或尝试。 |
| `042_shared_material_library.sql` | 新增独立材料库、不可变文件集合/处理结果、材料任务、项目加载关系和题目来源快照；为项目增加 `material_backend` 与 `workspace_path`，为 artifacts 增加同题复合唯一键；不迁移或更新旧材料数据。 |
| `043_publication_provenance.sql` | 追加可审计的归档/撤回事件，记录归档所用项目、题目、材料来源版本和脱敏附件摘要；事件保留工作流/尝试 UUID 为历史身份而不设外键，项目清理运行记录后仍能查材料使用历史；不改写既有归档尝试或删除交付文件。 |
| `031_project_period_root.sql` | 将已归组的第五期 `projects.material_root` 与对应 `workflows.source_manifest` 路径切换到 `projects/豆包高经济价值/第五期/questions/`；保留附件哈希、清单字段、材料行、步骤状态和执行历史。 |

执行前核对目标数据库、已登记文件和全部未执行 SQL。`024_remove_automation_control.sql` 删除旧自动批次、成员、阻断表、派发函数及项目暂停字段，不能为修复 Codex 设置顺便执行。数据库迁移、服务重启和真实接口核对是不同操作，均遵守根 [AGENTS.md](../AGENTS.md) 的授权约束。

不能从本目录存在文件推断当前数据库已应用它。不要删除旧文件、改名或重新编号来“整理”历史。
