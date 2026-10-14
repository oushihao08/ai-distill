-- 文件职责：显式区分旧式题目目录与材料包多题模式，并记录派生题目冻结的脱敏来源。
-- 旧项目及旧工作流默认保持“一目录一题”，不改写已有材料或执行历史。
ALTER TABLE ai_distill.projects
  ADD COLUMN material_mode text NOT NULL DEFAULT 'question_folders'
    CHECK (material_mode IN ('question_folders','material_packages'));

ALTER TABLE ai_distill.workflows
  ADD COLUMN workflow_kind text NOT NULL DEFAULT 'question'
    CHECK (workflow_kind IN ('question','material_package')),
  ADD COLUMN source_workflow_id uuid,
  ADD COLUMN source_redaction_attempt_id uuid,
  ADD COLUMN source_redaction_sha256 text,
  ADD COLUMN scenario text,
  ADD COLUMN role_perspective text,
  ADD COLUMN target_level text CHECK (target_level IS NULL OR target_level IN ('L2','L3','L4','L5')),
  ADD CONSTRAINT workflows_derived_source_pair CHECK (
    (source_workflow_id IS NULL AND source_redaction_attempt_id IS NULL AND source_redaction_sha256 IS NULL)
    OR (workflow_kind='question' AND source_workflow_id IS NOT NULL AND source_redaction_attempt_id IS NOT NULL
      AND source_redaction_sha256 IS NOT NULL
      AND source_redaction_sha256 ~ '^[a-f0-9]{64}$')
  ),
  ADD CONSTRAINT workflows_project_id_unique UNIQUE (project_id,id);

-- 复合外键防止跨项目引用、或把另一工作流的脱敏尝试写成来源。
ALTER TABLE ai_distill.workflows
  ADD CONSTRAINT workflows_source_same_project_fk
    FOREIGN KEY (project_id,source_workflow_id) REFERENCES ai_distill.workflows(project_id,id),
  ADD CONSTRAINT workflows_source_redaction_attempt_fk
    FOREIGN KEY (source_workflow_id,source_redaction_attempt_id)
    REFERENCES ai_distill.step_attempts(workflow_id,id);

CREATE INDEX workflows_source_workflow_idx ON ai_distill.workflows(source_workflow_id)
  WHERE source_workflow_id IS NOT NULL;
