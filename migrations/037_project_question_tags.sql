-- 文件职责：按期次项目保存可选出题标签，并为每道题保留创建时选择的标签快照。
-- 旧 target_level 与历史任务不改写；仅把已有题目的等级加入所属项目可用标签。
ALTER TABLE ai_distill.projects
  ADD COLUMN question_tags text[] NOT NULL DEFAULT '{}'::text[];

ALTER TABLE ai_distill.workflows
  ADD COLUMN question_tags text[] NOT NULL DEFAULT '{}'::text[];

UPDATE ai_distill.projects p
SET question_tags = source.tags
FROM (
  SELECT project_id, array_agg(DISTINCT target_level ORDER BY target_level) AS tags
  FROM ai_distill.workflows
  WHERE target_level IS NOT NULL AND deleted_at IS NULL
  GROUP BY project_id
) source
WHERE p.id = source.project_id;
