-- 允许可选材料整理显式选择API执行；原Agent整理与其他材料任务约束保持不变。
ALTER TABLE ai_distill.library_jobs DROP CONSTRAINT library_jobs_executor_kind;
ALTER TABLE ai_distill.library_jobs ADD CONSTRAINT library_jobs_executor_kind CHECK (
 (kind='intake' AND executor_kind='internal') OR
 (kind='extract' AND executor_kind IN ('internal','api')) OR
 (kind='redact' AND executor_kind IN ('internal','api','agent')) OR
 (kind='prepare' AND executor_kind IN ('agent','api') AND execution_target='local')
);
