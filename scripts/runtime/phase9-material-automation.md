# 第九期材料自动任务操作单

适用：automation-2，每50小时执行。供执行Agent读取；不是出题Skill，也不作为材料附件。用户最新指令及根AGENTS.md优先。更新业务规则时只维护本文件，定时提示词只引用此路径。

## 固定范围与边界

- 仓库：`/Users/jack/Documents/codes/lvgou/ai-distill`；API：`http://127.0.0.1:3700`。
- 包名严格 startsWith `豆包高经济第九期`，未归档；目标`豆包高经济价值 - 第九期`，ID `68619f74-c864-49a0-bbe6-495202e62556`，须回读核对名称及aliases模式。
- 允许：符合来源的已整理包加载、每包缺失时创建一个题目身份；成功可用aliases包数曾达590后，按实际Agent容量派发新的aliases脱敏。
- 不提取、不整理、不派发出题/作答/评分/交付；不改模型、并发、配置、业务代码，不直连数据库、不重启服务、不运行测试。取消过的出题不恢复；归档重复包不恢复。

## 最短单轮路径

1. **先恢复再新增**：检查本任务进程与最近运行记录。有批次运行则跟踪原进程，不另起并行写入；原批次结束后再补扫。未知请求先查原业务状态，保留原UUID请求键及完整请求体，不能换键盲重发。
2. **一次建立索引**：GET项目、`/api/projects/:id/material-processing`、`/api/projects/:id/loaded-materials?include_removed=true`、`/api/system/execution-queue`。按workflow.library_package_id和link.package_id索引，不逐包重复读取全项目。API不可用则记录并停止写入。
3. **全量分页候选**：GET `/api/material-library/packages?q=豆包高经济第九期&redaction_state=ready&preparation_state=ready&page_size=100&page=N`，以total_count翻完，再严格匹配名称、排除归档。已有题目跳过；已移除引用不恢复。
4. **仅检查缺题包详情**：GET `/api/material-library/packages/:id/revisions`、`/api/material-library/packages/:id/preparations?revision_id=:revision&redaction_id=:redaction&project_id=:project`。选择当前revision成功可用aliases脱敏、同revision同redaction成功整理，整理project_id为目标或null（项目专属优先）。已有link选版保持不变；来源不同则记录阻断。
5. **记录整理评分**：从所选同来源整理的`result.question_support`记录score/status/reason。8–10为usable；6–7为limited；0–5为dangerous；高分无有效候选为preparation_error；缺失为unknown。评分与提取/脱敏机械校验、页数门槛、最终题目达标是不同指标。当前用户未明确评分过滤线，**不得声称已有评分拦截，也不擅自按分数删除、移除或改变加载范围**；新增低支持度或输入截断异常单独报告，是否过滤按后续明确指令更新本文件。历史评价不自动重算，原因称输入截断不等于原件损坏。
6. **串行写入与回执**：无link时POST `/api/projects/:id/loaded-materials`，body `{package_id,redaction_id}`；保留服务端重复/跨期占用/页数准入结果，不绕过。建题前再GET项目防并发重复；POST `/api/projects/:id/loaded-materials/:linkId/questions`，body `{request_key,expected_link_version:Number(link.lock_version),redaction_id,title:包名,question_tags:[]}`。标题明确L2–L5才传相同target_level；角色场景方向未指定。已有link不切换来源。
7. **脱敏补位**：590阈值已在`hourly-20261113T164151Z/redaction-census.json`核实594包，后续不重复全库逐包读取来重证已触发事件。统计当前数量时按当前revision成功可用aliases不同包计数，不用ready列表数冒充精确数量。Agent运行层和等待层分别看实时limit/running/queued/reserved/waiting/available；满则不请求包详情。未满时全量分页查not_ready候选，再逐包读当前revision，排除成功、活动、排队、未知及失败/取消需续作记录。完整成功extract来源才POST `/api/material-library/revisions/:id/jobs`：`{kind:'redact',request_key:UUID,execution_target:'local',extraction_job_id,project_id}`。每次持久化后提交、保存回执、重读容量，直到满或全量合法候选耗尽。失败/取消不自动重试，不占用他机任务。
8. **结束回读**：读取项目、加载关系和队列，记录新加载、新建题、脱敏接受数、阻断及未决请求。计数以回读为准，接受不等于成功。无新增/新异常保持安静；完成、失败、需用户决定才通知。

## 记录与更新方式

- 每轮独立目录：`.storage/phase9-hourly-load-create-20261113/<UTC运行时间>/`；写前保存来源、评分、请求及UUID，写后保存link/workflow/job ID和响应。旧receipt和首次run.mjs不覆盖、不直接重放。
- 可参考既有run.mjs/redact.mjs的HTTP契约，但执行前核对其与本文件是否一致；特别是历史脚本没有评分记录、可能继续处理未知请求，不能无审查复制执行。
- 当前契约权威：根AGENTS.md、根README.md、`.agents/skills/ai-distill-workflow/SKILL.md`、`server/material-library/README.md`、`server/execution-queue/README.md`。首次或这些文件有变化才补读相关段落；每轮先读本操作单和根AGENTS.md。不扫描历史docs，不重复全库质量审计。
- 更新时：读最新用户要求及直接相关源码/文档 → 修改本文件对应规则 → 检查前后矛盾和接口字段 → 保持定时提示词只引用此路径。源码更新不等于运行服务已加载，以实际API验证，不擅自重启。
- 禁用`scripts/runtime/phase9-authoring-dispatch.ts`作为本任务入口：它直连数据库且派发出题，超出本任务范围。
