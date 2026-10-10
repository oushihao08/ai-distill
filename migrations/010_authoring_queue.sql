-- 文件职责：启用出题／质检步骤并建立等待、运行任务索引。
UPDATE ai_distill.steps SET implemented=true WHERE ordinal=4;
CREATE INDEX authoring_attempts_pending ON ai_distill.step_attempts(status,started_at) WHERE ordinal=4 AND status IN ('waiting','running');
