-- 文件职责：把已登记的第五期题目来源切换到主项目／期次目录，不触碰附件与工作流状态。
WITH target_projects AS (
 SELECT id,
        regexp_replace(material_root,'/+$','') AS old_root,
        regexp_replace(material_root,'/projects/豆包高经济价值-第五期/questions/?$','/projects/豆包高经济价值/第五期/questions') AS new_root
 FROM ai_distill.projects
 WHERE parent_name='豆包高经济价值'
   AND phase_name='第五期'
   AND material_root ~ '/projects/豆包高经济价值-第五期/questions/?$'
)
UPDATE ai_distill.workflows AS workflow
SET source_manifest=(
 SELECT COALESCE(jsonb_agg(
   CASE
    WHEN jsonb_typeof(entry.value)='object'
     AND entry.value->>'path' LIKE target.old_root || '/%'
    THEN jsonb_set(entry.value,'{path}',to_jsonb(target.new_root || substring(entry.value->>'path' FROM length(target.old_root)+1)))
    ELSE entry.value
   END ORDER BY entry.ordinality
 ),'[]'::jsonb)
 FROM jsonb_array_elements(workflow.source_manifest) WITH ORDINALITY AS entry(value,ordinality)
)
FROM target_projects AS target
WHERE workflow.project_id=target.id;

UPDATE ai_distill.projects
SET material_root=regexp_replace(material_root,'/projects/豆包高经济价值-第五期/questions/?$','/projects/豆包高经济价值/第五期/questions')
WHERE parent_name='豆包高经济价值'
  AND phase_name='第五期'
  AND material_root ~ '/projects/豆包高经济价值-第五期/questions/?$';
