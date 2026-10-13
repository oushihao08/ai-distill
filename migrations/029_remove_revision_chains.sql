-- 文件职责：删除已停用返修流程的空表及 step_attempts 返修轮次关联。
DROP TABLE IF EXISTS ai_distill.revision_calls;
ALTER TABLE ai_distill.step_attempts DROP COLUMN IF EXISTS revision_round_id;
DROP TABLE IF EXISTS ai_distill.revision_rounds;
DROP TABLE IF EXISTS ai_distill.revision_chains;
