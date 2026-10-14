-- 文件职责：持久化系统级脱敏、出题、模型作答与独立评分提示词；默认正文仍由代码提供。
ALTER TABLE ai_distill.system_codex_config
  ADD COLUMN IF NOT EXISTS step_prompts jsonb NOT NULL DEFAULT '{}'::jsonb;
