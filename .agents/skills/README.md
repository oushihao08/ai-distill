# 操作 Skill

`ai-distill-workflow` 是指向根目录 `skill/` 的符号链接，用于通过现有本机 API 执行用户指定的工作流范围。新增操作规则应基于 CLI 帮助和共享步骤注册表，不复制服务端业务算法。

`ai-distill-scheduled-runner` 指向 `../../toolSkills/ai-distill-scheduled-runner`，负责按指定间隔建立定时任务、维护对账台并主动使用CLI推进授权批次。

`ai-trace-review` 指向 `../../toolSkills/ai-trace-review`，审查题目/交付残留与命名雷同；仅在明确授权后使用改名工具，不自动修改业务状态。

`phase8-materials-full-capacity` 指向 `../../toolSkills/phase8-materials-full-capacity`，仅用于第八期八个来源目录的三阶段材料处理与双 lane 满载补位。
