-- 文件职责：启用模型作答步骤并建立其任务队列索引。
UPDATE ai_distill.steps SET implemented=true WHERE ordinal=5;
CREATE INDEX answer_attempts_pending ON ai_distill.step_attempts(status,started_at) WHERE ordinal=5;
