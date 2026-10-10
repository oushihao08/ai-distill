-- 文件职责：补充系统默认 Codex 模型和推理强度，保留已有配置兼容。
ALTER TABLE ai_distill.system_codex_config
  ADD COLUMN IF NOT EXISTS model text NOT NULL DEFAULT 'gpt-6.1-sol',
  ADD COLUMN IF NOT EXISTS reasoning_effort text NOT NULL DEFAULT 'medium';
