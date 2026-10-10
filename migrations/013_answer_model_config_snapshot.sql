-- 文件职责：将模型 provider／endpoint／model 固定到结构化配置字段。
ALTER TABLE ai_distill.system_answer_models ADD COLUMN config jsonb;
UPDATE ai_distill.system_answer_models SET config=jsonb_build_object('provider',provider,'base_url',base_url,'model',model);
ALTER TABLE ai_distill.system_answer_models ALTER COLUMN config SET NOT NULL;
