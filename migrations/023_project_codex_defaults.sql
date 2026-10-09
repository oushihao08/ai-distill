ALTER TABLE ai_distill.projects
  ADD COLUMN IF NOT EXISTS codex_model text,
  ADD COLUMN IF NOT EXISTS codex_reasoning_effort text;
