<!-- 文件职责：说明项目当前资料与 skill 管理界面。 -->
# 项目资料与 skill

- `ProjectRules.vue`：登记本地工作区、查看资料与 skill并管理当前项目文件。
- `RuleFileEditor.vue`：读取文件；文字编辑或文件替换仅面向 `materials/`，skill 保持只读。修改已有文件携带 SHA-256 以检查并发变化。
- `SkillGeneration.vue`：生成独立候选、轮询尝试；采用候选后更新项目当前 skill 路径。

依赖项目 rules/skill 接口、共享类型和 `useResource`。新任务按步骤读取当前项目文件并记录本次指纹；历史规则版本不再用于派发，也不代表题目已经完成质检或达到正式交付条件。
