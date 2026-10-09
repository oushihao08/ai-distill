DROP FUNCTION IF EXISTS ai_distill.dispatch_allowed(uuid, text);
DROP TABLE IF EXISTS ai_distill.automation_members;
DROP TABLE IF EXISTS ai_distill.automation_batches;
DROP TABLE IF EXISTS ai_distill.executor_blocks;
ALTER TABLE ai_distill.projects DROP COLUMN IF EXISTS execution_paused;
