-- 文件职责：启用独立评分步骤并建立评分任务队列索引。
UPDATE ai_distill.steps SET implemented=true WHERE ordinal=6;
CREATE INDEX IF NOT EXISTS score_attempt_queue ON ai_distill.step_attempts(status,started_at,id) WHERE ordinal=6 AND status IN ('waiting','running');
