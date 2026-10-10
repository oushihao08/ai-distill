-- 文件职责：修正步骤模板顺序，补齐附件与返修记录的归属约束及外键索引。
-- Restore the visible positions changed temporarily to avoid unique collisions
-- in migration 025. Internal steps remain outside the visible sequence.
UPDATE ai_distill.project_workflow_steps
SET position = CASE step_key
  WHEN 'receive_materials' THEN 1
  WHEN 'redact_materials' THEN 2
  WHEN 'extract_text' THEN 99
  WHEN 'load_rules' THEN 103
  ELSE position
END
WHERE step_key IN ('receive_materials','redact_materials','extract_text','load_rules');

-- Composite unique keys let PostgreSQL enforce that each related row belongs
-- to the same workflow, not merely that each referenced ID exists.
ALTER TABLE ai_distill.step_attempts
  ADD CONSTRAINT step_attempts_workflow_id_unique UNIQUE (workflow_id,id),
  ADD CONSTRAINT step_attempts_round_id_unique UNIQUE (revision_round_id,id);
ALTER TABLE ai_distill.materials
  ADD CONSTRAINT materials_workflow_id_unique UNIQUE (workflow_id,id);
ALTER TABLE ai_distill.revision_chains
  ADD CONSTRAINT revision_chains_id_workflow_unique UNIQUE (id,workflow_id);
ALTER TABLE ai_distill.revision_rounds
  ADD COLUMN workflow_id uuid;
UPDATE ai_distill.revision_rounds r
SET workflow_id = c.workflow_id
FROM ai_distill.revision_chains c
WHERE c.id = r.chain_id;
ALTER TABLE ai_distill.revision_rounds
  ALTER COLUMN workflow_id SET NOT NULL;
ALTER TABLE ai_distill.revision_rounds
  ADD CONSTRAINT revision_rounds_chain_id_unique UNIQUE (chain_id,id);
ALTER TABLE ai_distill.revision_rounds
  ADD CONSTRAINT revision_rounds_chain_workflow_fk
    FOREIGN KEY (chain_id,workflow_id) REFERENCES ai_distill.revision_chains(id,workflow_id),
  ADD CONSTRAINT revision_rounds_workflow_attempt_fk
    FOREIGN KEY (workflow_id,source_attempt_id) REFERENCES ai_distill.step_attempts(workflow_id,id),
  ADD CONSTRAINT revision_rounds_parent_same_chain_fk
    FOREIGN KEY (chain_id,parent_round_id) REFERENCES ai_distill.revision_rounds(chain_id,id);

ALTER TABLE ai_distill.revision_chains
  ADD CONSTRAINT revision_chains_workflow_attempt_fk
    FOREIGN KEY (workflow_id,source_attempt_id) REFERENCES ai_distill.step_attempts(workflow_id,id);
ALTER TABLE ai_distill.artifacts
  ADD CONSTRAINT artifacts_workflow_material_fk
    FOREIGN KEY (workflow_id,material_id) REFERENCES ai_distill.materials(workflow_id,id),
  ADD CONSTRAINT artifacts_workflow_attempt_fk
    FOREIGN KEY (workflow_id,attempt_id) REFERENCES ai_distill.step_attempts(workflow_id,id);
ALTER TABLE ai_distill.revision_calls
  ADD CONSTRAINT revision_calls_chain_round_fk
    FOREIGN KEY (chain_id,round_id) REFERENCES ai_distill.revision_rounds(chain_id,id),
  ADD CONSTRAINT revision_calls_round_attempt_fk
    FOREIGN KEY (round_id,attempt_id) REFERENCES ai_distill.step_attempts(revision_round_id,id);

-- PostgreSQL does not automatically index referencing columns. These indexes
-- cover FK checks and the existing direct lookups by those IDs.
CREATE INDEX artifacts_material_id_idx ON ai_distill.artifacts(material_id);
CREATE INDEX artifacts_attempt_id_idx ON ai_distill.artifacts(attempt_id);
CREATE INDEX revision_chains_source_attempt_idx ON ai_distill.revision_chains(source_attempt_id);
CREATE INDEX revision_rounds_parent_round_idx ON ai_distill.revision_rounds(parent_round_id);
CREATE INDEX revision_rounds_source_attempt_idx ON ai_distill.revision_rounds(source_attempt_id);
CREATE INDEX revision_calls_round_idx ON ai_distill.revision_calls(round_id);
CREATE INDEX revision_calls_attempt_idx ON ai_distill.revision_calls(attempt_id);
CREATE INDEX project_answer_models_model_idx ON ai_distill.project_answer_models(model_id);
CREATE INDEX workflows_rule_version_idx ON ai_distill.workflows(rule_version_id);
