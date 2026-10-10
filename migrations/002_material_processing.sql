-- 文件职责：补充材料任务心跳和提取队列索引，启用历史提取步骤。
ALTER TABLE ai_distill.step_attempts ADD COLUMN heartbeat_at timestamptz;
UPDATE ai_distill.steps SET implemented=true WHERE ordinal=2;
CREATE INDEX attempts_pending ON ai_distill.step_attempts(status,started_at) WHERE ordinal=2;
