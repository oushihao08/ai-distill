-- 文件职责：允许作答模型目录登记 SiliconFlow API provider。
ALTER TABLE ai_distill.system_answer_models
  DROP CONSTRAINT IF EXISTS system_answer_models_provider_check;

ALTER TABLE ai_distill.system_answer_models
  ADD CONSTRAINT system_answer_models_provider_check
  CHECK (provider IN ('qwen','kimi','deepseek','doubao','openrouter','codex','siliconflow'));
