-- 文件职责：兼容历史返修表的 stage 字段，并扩展材料返修阶段约束。
-- Some existing databases were created before revision_rounds.stage was added
-- to migration 015. Keep this migration compatible with both schema histories.
ALTER TABLE ai_distill.revision_rounds ADD COLUMN IF NOT EXISTS stage integer;

UPDATE ai_distill.revision_rounds r
SET stage = CASE
  WHEN r.decision->>'return_step' IN ('2','4','5','6','7','9')
    THEN (r.decision->>'return_step')::integer
  ELSE (
    SELECT a.ordinal
    FROM ai_distill.step_attempts a
    WHERE a.id = r.source_attempt_id AND a.ordinal IN (2,4,5,6,7,9)
  )
END
WHERE r.stage IS NULL;

ALTER TABLE ai_distill.revision_rounds DROP CONSTRAINT IF EXISTS revision_rounds_stage_check;
ALTER TABLE ai_distill.revision_rounds ADD CONSTRAINT revision_rounds_stage_check CHECK(stage IS NULL OR stage IN (2,4,5,6,7,9));
