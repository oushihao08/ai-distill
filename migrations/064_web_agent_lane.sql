-- 网页Agent（DeepSeek/Gemini网页）独立执行通道：新增lane='web'，并允许材料脱敏/整理使用executor_kind='web'。
-- 042列内联的executor_kind检查（library_jobs_executor_kind_check）此前未被后续迁移移除，须与命名约束一并放宽；
-- 网页执行只在本机浏览器会话中进行，故executor_target约束把web与agent同样限定为execution_target='local'。
-- 不回填或改写历史任务；各业务类型的web允许范围见下方命名约束。
ALTER TABLE ai_distill.execution_dispatches DROP CONSTRAINT IF EXISTS execution_dispatches_lane_check;
ALTER TABLE ai_distill.execution_dispatches ADD CONSTRAINT execution_dispatches_lane_check CHECK(lane IN ('agent','api','internal','hook','remote','web'));
ALTER TABLE ai_distill.library_jobs DROP CONSTRAINT IF EXISTS library_jobs_executor_kind_check;
ALTER TABLE ai_distill.library_jobs ADD CONSTRAINT library_jobs_executor_kind_check CHECK (executor_kind IN ('internal','api','agent','web'));
ALTER TABLE ai_distill.library_jobs DROP CONSTRAINT library_jobs_executor_target;
ALTER TABLE ai_distill.library_jobs ADD CONSTRAINT library_jobs_executor_target CHECK (executor_kind NOT IN ('agent','web') OR execution_target='local');
ALTER TABLE ai_distill.library_jobs DROP CONSTRAINT library_jobs_executor_kind;
ALTER TABLE ai_distill.library_jobs ADD CONSTRAINT library_jobs_executor_kind CHECK (
 (kind='intake' AND executor_kind='internal') OR
 (kind='extract' AND executor_kind IN ('internal','api')) OR
 (kind='redact' AND executor_kind IN ('internal','api','agent','web')) OR
 (kind='prepare' AND executor_kind IN ('agent','api','web') AND execution_target='local')
);
