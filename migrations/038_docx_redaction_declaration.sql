-- DOCX is model-redacted by default. A declaration belongs to this exact managed
-- material row; replacing the attachment creates a new row with the default.
ALTER TABLE ai_distill.materials
  ADD COLUMN redaction_mode text NOT NULL DEFAULT 'model'
  CONSTRAINT materials_redaction_mode_check CHECK (redaction_mode IN ('model', 'declared_redacted'));
