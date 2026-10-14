-- 文件职责：为每道题目保存可选出题方向；空值表示无额外方向。
ALTER TABLE ai_distill.workflows ADD COLUMN authoring_direction text;
