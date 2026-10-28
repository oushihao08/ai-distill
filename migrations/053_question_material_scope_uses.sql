-- 保存共享材料题的最终方向+场景组合；唯一范围为期次project_id，不回填无法可靠还原的历史题。
CREATE TABLE ai_distill.question_material_scope_uses (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 project_id uuid NOT NULL REFERENCES ai_distill.projects(id) ON DELETE CASCADE,
 workflow_id uuid NOT NULL REFERENCES ai_distill.workflows(id) ON DELETE CASCADE,
 attempt_id uuid NOT NULL REFERENCES ai_distill.step_attempts(id) ON DELETE RESTRICT,
 direction text NOT NULL CHECK (length(btrim(direction)) > 0),
 scene text NOT NULL CHECK (length(btrim(scene)) > 0),
 scope_key text NOT NULL CHECK (scope_key ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(project_id,scope_key),
 UNIQUE(workflow_id,scope_key)
);
CREATE INDEX question_material_scope_uses_project ON ai_distill.question_material_scope_uses(project_id,created_at);
