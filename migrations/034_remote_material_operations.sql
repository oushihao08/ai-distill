-- 文件职责：为远程材料处理增加任务归属与可恢复的组合操作记录；旧尝试保持本机归属。
ALTER TABLE ai_distill.step_attempts
 ADD COLUMN execution_target text NOT NULL DEFAULT 'local'
 CHECK (execution_target IN ('local', 'server'));

CREATE TABLE ai_distill.remote_material_operations (
 id uuid PRIMARY KEY,
 workflow_id uuid NOT NULL REFERENCES ai_distill.workflows(id) ON DELETE CASCADE,
 mode text NOT NULL CHECK (mode IN ('intake', 'redact', 'intake-redact')),
 request_key text NOT NULL,
 source_digest text NOT NULL,
 material_digest text,
 redaction_config_digest text,
 status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'running', 'succeeded', 'failed')),
 stage text NOT NULL DEFAULT 'intake' CHECK (stage IN ('intake', 'extract', 'redact', 'complete')),
 intake_attempt_id uuid REFERENCES ai_distill.step_attempts(id) ON DELETE SET NULL,
 extraction_attempt_id uuid REFERENCES ai_distill.step_attempts(id) ON DELETE SET NULL,
 redaction_attempt_id uuid REFERENCES ai_distill.step_attempts(id) ON DELETE SET NULL,
 error_code text,
 claim_token uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (workflow_id, request_key)
);

CREATE INDEX remote_material_operations_pending
 ON ai_distill.remote_material_operations(status, updated_at)
 WHERE status IN ('waiting', 'running');

CREATE UNIQUE INDEX remote_material_operations_one_active
 ON ai_distill.remote_material_operations(workflow_id)
 WHERE status IN ('waiting', 'running');
