-- 文件职责：为期次工作流记录其所属主项目与期数，并允许同一主项目的期次共享 skill 路径。
ALTER TABLE ai_distill.projects ADD COLUMN parent_name text;
ALTER TABLE ai_distill.projects ADD COLUMN phase_name text NOT NULL DEFAULT '';
DROP INDEX IF EXISTS ai_distill.projects_local_skill_path;

-- 已知第五期记录显式归组；其他旧项目不按名称猜测期数。
UPDATE ai_distill.projects
SET parent_name = '豆包高经济价值',
    phase_name = '第五期',
    local_skill_path = CASE
      WHEN material_root ~ '/projects/豆包高经济价值( -|-)?第五期/questions/?$'
        THEN regexp_replace(material_root, '/projects/豆包高经济价值( -|-)?第五期/questions/?$', '/projects/豆包高经济价值/skill')
      WHEN local_skill_path ~ '/projects/豆包高经济价值( -|-)?第五期/skill/?$'
        THEN regexp_replace(local_skill_path, '/projects/豆包高经济价值( -|-)?第五期/skill/?$', '/projects/豆包高经济价值/skill')
      ELSE local_skill_path
    END
WHERE parent_name IS NULL
  AND name IN ('豆包高经济价值 - 第五期', '豆包高经济价值-第五期');

UPDATE ai_distill.projects SET parent_name=name WHERE parent_name IS NULL;
ALTER TABLE ai_distill.projects ALTER COLUMN parent_name SET NOT NULL;

CREATE INDEX projects_parent_name_active ON ai_distill.projects(parent_name) WHERE deleted_at IS NULL;
