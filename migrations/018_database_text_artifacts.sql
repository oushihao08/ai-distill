ALTER TABLE ai_distill.artifacts ADD COLUMN content text;

CREATE INDEX artifacts_material_phase ON ai_distill.artifacts(workflow_id,material_id,kind,created_at DESC)
WHERE material_id IS NOT NULL;
