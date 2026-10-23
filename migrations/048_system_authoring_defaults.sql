-- 职责：系统配置增加仅用于新建期次的出题默认值；不回写既有期次、答案或任务快照。
ALTER TABLE ai_distill.system_codex_config
 ADD COLUMN IF NOT EXISTS authoring_defaults jsonb NOT NULL
 DEFAULT '{"model":"gpt-6.1-sol","reasoning_effort":"low"}'::jsonb;
