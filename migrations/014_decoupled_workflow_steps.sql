-- 文件职责：拆分稳定步骤 key、持久化 ordinal 与显示顺序，新增独立脱敏身份。
-- Give every stage a stable key and a separate display order. Ordinals remain
-- storage IDs so historic attempts and their foreign keys are not renumbered.
ALTER TABLE ai_distill.steps
  DROP CONSTRAINT IF EXISTS steps_ordinal_check;
ALTER TABLE ai_distill.steps
  ADD CONSTRAINT steps_ordinal_check CHECK (ordinal BETWEEN 1 AND 9);
ALTER TABLE ai_distill.steps
  ADD COLUMN step_key text,
  ADD COLUMN display_position integer,
  ADD COLUMN enabled boolean NOT NULL DEFAULT true;

UPDATE ai_distill.steps SET
  step_key = CASE ordinal
    WHEN 1 THEN 'receive_materials'
    WHEN 2 THEN 'extract_text'
    WHEN 3 THEN 'load_rules'
    WHEN 4 THEN 'author_quality'
    WHEN 5 THEN 'model_answer'
    WHEN 6 THEN 'independent_score'
    WHEN 7 THEN 'accept_or_revise'
    WHEN 8 THEN 'publish_export'
  END,
  display_position = CASE WHEN ordinal >= 3 THEN ordinal + 1 ELSE ordinal END,
  name = CASE ordinal
    WHEN 1 THEN '接收材料'
    WHEN 2 THEN '提取文本'
    WHEN 3 THEN '加载本期规则'
    WHEN 4 THEN '出题与质检'
    WHEN 5 THEN '模型作答'
    WHEN 6 THEN '独立评分'
    WHEN 7 THEN '达标或返修'
    WHEN 8 THEN '发布成果与导出'
  END;

ALTER TABLE ai_distill.steps
  ALTER COLUMN step_key SET NOT NULL,
  ALTER COLUMN display_position SET NOT NULL,
  ADD CONSTRAINT steps_workflow_key_unique UNIQUE(workflow_id, step_key),
  ADD CONSTRAINT steps_display_position_positive CHECK (display_position > 0);

INSERT INTO ai_distill.steps(workflow_id,ordinal,name,status,implemented,step_key,display_position,enabled)
SELECT id,9,'脱敏与检查','waiting',true,'redact_materials',3,true
FROM ai_distill.workflows;

ALTER TABLE ai_distill.project_step_configs
  DROP CONSTRAINT IF EXISTS project_step_configs_ordinal_check;
ALTER TABLE ai_distill.project_step_configs
  ADD CONSTRAINT project_step_configs_ordinal_check CHECK (ordinal BETWEEN 1 AND 9);

-- Project templates contain only registered step keys. `enabled` and position
-- are copied onto workflow steps at creation; config remains project-scoped.
CREATE TABLE ai_distill.project_workflow_steps (
  project_id uuid NOT NULL REFERENCES ai_distill.projects(id) ON DELETE CASCADE,
  step_key text NOT NULL,
  position integer NOT NULL CHECK (position > 0),
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,step_key),
  UNIQUE(project_id,position)
);

INSERT INTO ai_distill.project_workflow_steps(project_id,step_key,position,enabled)
SELECT p.id,v.step_key,v.position,true
FROM ai_distill.projects p
CROSS JOIN (VALUES
 ('receive_materials',1),('extract_text',2),('redact_materials',3),
 ('load_rules',4),('author_quality',5),('model_answer',6),
 ('independent_score',7),('accept_or_revise',8),('publish_export',9)
) AS v(step_key,position);

CREATE INDEX project_workflow_steps_order ON ai_distill.project_workflow_steps(project_id,position);
