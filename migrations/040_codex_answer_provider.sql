-- 文件职责：允许作答模型目录准确标记由本机 Codex Agent 执行的模型。
ALTER TABLE ai_distill.system_answer_models
  DROP CONSTRAINT IF EXISTS system_answer_models_provider_check;

ALTER TABLE ai_distill.system_answer_models
  ADD CONSTRAINT system_answer_models_provider_check
  CHECK (provider IN ('qwen','kimi','deepseek','doubao','openrouter','codex'));
