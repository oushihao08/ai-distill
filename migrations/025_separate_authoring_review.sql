-- 文件职责：将出题与独立审查分成稳定的两个可见步骤，保留既有尝试序号。
ALTER TABLE ai_distill.steps
  DROP CONSTRAINT IF EXISTS steps_ordinal_check;
ALTER TABLE ai_distill.steps
  ADD CONSTRAINT steps_ordinal_check CHECK (ordinal BETWEEN 1 AND 10);

-- Existing authoring attempts remain at ordinal 4; their old result is history.
UPDATE ai_distill.steps
SET step_key='author_question', name='出题', display_position=3
WHERE ordinal=4;
UPDATE ai_distill.steps
SET display_position=CASE ordinal WHEN 5 THEN 5 WHEN 6 THEN 6 WHEN 7 THEN 7 WHEN 8 THEN 8 ELSE display_position END
WHERE ordinal BETWEEN 5 AND 8;
INSERT INTO ai_distill.steps(workflow_id,ordinal,name,status,implemented,step_key,display_position,enabled)
SELECT w.id,10,'独立审查','waiting',true,'review_question',4,true
FROM ai_distill.workflows w
ON CONFLICT (workflow_id,step_key) DO NOTHING;

-- Project templates keep their existing project-scoped ordering without
-- changing the unrelated project-step configuration constraint (ordinal <= 9).
UPDATE ai_distill.project_workflow_steps SET position=position+100;
UPDATE ai_distill.project_workflow_steps SET step_key='author_question',position=3 WHERE step_key='author_quality';
UPDATE ai_distill.project_workflow_steps SET position=5 WHERE step_key='model_answer';
UPDATE ai_distill.project_workflow_steps SET position=6 WHERE step_key='independent_score';
UPDATE ai_distill.project_workflow_steps SET position=7 WHERE step_key='accept_or_revise';
UPDATE ai_distill.project_workflow_steps SET position=8 WHERE step_key='publish_export';
INSERT INTO ai_distill.project_workflow_steps(project_id,step_key,position,enabled)
SELECT p.id,'review_question',4,true FROM ai_distill.projects p
ON CONFLICT (project_id,step_key) DO NOTHING;

ALTER TABLE ai_distill.revision_rounds DROP CONSTRAINT IF EXISTS revision_rounds_stage_check;
ALTER TABLE ai_distill.revision_rounds
  ADD CONSTRAINT revision_rounds_stage_check CHECK(stage IS NULL OR stage IN (2,4,5,6,7,9,10));
