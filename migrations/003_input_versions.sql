-- 文件职责：增加题目来源标识与材料／尝试输入版本，建立版本查询索引。
ALTER TABLE ai_distill.workflows ADD COLUMN source_key text;
ALTER TABLE ai_distill.workflows ADD COLUMN input_revision integer NOT NULL DEFAULT 1 CHECK (input_revision > 0);
CREATE UNIQUE INDEX workflows_project_source ON ai_distill.workflows(project_id,source_key) WHERE source_key IS NOT NULL;
ALTER TABLE ai_distill.materials ADD COLUMN input_revision integer NOT NULL DEFAULT 1 CHECK (input_revision > 0);
ALTER TABLE ai_distill.step_attempts ADD COLUMN input_revision integer NOT NULL DEFAULT 1 CHECK (input_revision > 0);
CREATE INDEX materials_workflow_revision ON ai_distill.materials(workflow_id,input_revision);
