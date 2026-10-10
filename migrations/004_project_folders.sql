-- 文件职责：登记项目材料／skill 目录、来源清单与逻辑删除状态，建立项目步骤配置。
ALTER TABLE ai_distill.projects ADD COLUMN material_root text;
ALTER TABLE ai_distill.projects ADD COLUMN local_skill_path text;
ALTER TABLE ai_distill.projects ADD COLUMN deleted_at timestamptz;
ALTER TABLE ai_distill.workflows ADD COLUMN source_manifest jsonb NOT NULL DEFAULT '[]';
ALTER TABLE ai_distill.workflows ADD COLUMN deleted_at timestamptz;
CREATE UNIQUE INDEX projects_local_skill_path ON ai_distill.projects(local_skill_path) WHERE deleted_at IS NULL AND local_skill_path IS NOT NULL;
CREATE TABLE ai_distill.project_step_configs (
 project_id uuid NOT NULL REFERENCES ai_distill.projects(id), ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 8), config jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(project_id,ordinal)
);
