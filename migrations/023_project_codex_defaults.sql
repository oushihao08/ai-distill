-- 文件职责：补充项目级 Codex 默认设置；未设置时由服务端解析继承。
ALTER TABLE ai_distill.projects
  ADD COLUMN IF NOT EXISTS codex_model text,
  ADD COLUMN IF NOT EXISTS codex_reasoning_effort text;
