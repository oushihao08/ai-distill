<!-- 文件职责：索引豆包高经济价值项目的 skill 候选生成验证脚本。 -->
# Skill 验证脚本

| 脚本 | 用途与影响 |
| --- | --- |
| `verify-project-skill.ts` | 读取第五期真实规则及硬编码的外部模板目录，调用真实 Codex 生成 skill 候选；候选写 `.storage/skill-generation-smoke/`，状态摘要写仓库 `docs/evidence/project-skill-smoke-results.json`；不自动采用或发布。 |

该脚本会使用真实项目规则并调用 Codex。执行前核对脚本里的项目路径、外部模板路径、模型和输出位置；摘要文件位于 `docs/evidence/`，不是私有存储。项目目录中的文件只作为验证输入，不要把候选结果直接当作已采用 skill。
