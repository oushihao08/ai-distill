ALTER TABLE ai_distill.system_answer_models
  DROP CONSTRAINT IF EXISTS system_answer_models_provider_check;

ALTER TABLE ai_distill.system_answer_models
  ADD CONSTRAINT system_answer_models_provider_check
  CHECK (provider IN ('qwen','kimi','deepseek','doubao','openrouter'));

ALTER TABLE ai_distill.project_answer_models
  ALTER COLUMN minimum_score DROP NOT NULL;
