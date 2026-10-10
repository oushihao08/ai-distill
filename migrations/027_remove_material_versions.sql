-- 文件职责：撤除材料版本字段；按迁移前的当前附件归属保留材料，历史附件只标记移除，不删除原件、文本或执行记录。
-- 部署时先停止派发并停止 API/worker；该迁移与撤除版本的代码必须一起切换，不能与旧进程混用。
ALTER TABLE ai_distill.materials ADD COLUMN deleted_at timestamptz;
UPDATE ai_distill.materials m SET deleted_at=now()
FROM ai_distill.workflows w WHERE w.id=m.workflow_id AND m.input_revision<>w.input_revision;
CREATE INDEX materials_active_workflow ON ai_distill.materials(workflow_id) WHERE deleted_at IS NULL;

-- 已有任务冻结摘要包含旧字段，不能冒充新契约的执行结果。
-- 保留全部历史；取消活动任务，保留已完成的入库/提取，后续由用户重新派发脱敏与出题。
UPDATE ai_distill.step_attempts SET status='skipped',error='材料版本机制已移除，请重新派发',finished_at=now()
WHERE status IN ('waiting','running');
UPDATE ai_distill.steps SET status='waiting',result=NULL,error=NULL,started_at=NULL,finished_at=NULL
WHERE ordinal NOT IN (1,2) OR status IN ('waiting','running');
UPDATE ai_distill.materials SET processing_status='text_extracted'
WHERE deleted_at IS NULL AND processing_status='redacted';
UPDATE ai_distill.revision_chains SET status='stale',reason='material_versions_removed',updated_at=now()
WHERE status IN ('waiting','running','blocked');
UPDATE ai_distill.project_exports SET status='stale',error='材料版本机制已移除',finished_at=now()
WHERE status IN ('running','succeeded');
UPDATE ai_distill.workflows SET status='waiting' WHERE deleted_at IS NULL;

-- 清理数据库 JSON 中的旧字段，保留历史正文、绑定及其原始摘要供追溯；历史摘要不用于新任务复用。
CREATE FUNCTION ai_distill.remove_material_version_fields(value jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE cleaned jsonb;
BEGIN
 IF jsonb_typeof(value)='object' THEN
  SELECT coalesce(jsonb_object_agg(key,ai_distill.remove_material_version_fields(item)),'{}'::jsonb) INTO cleaned
  FROM jsonb_each(value) AS entry(key,item) WHERE key NOT IN ('input_revision','current_input_revision');
  RETURN cleaned;
 ELSIF jsonb_typeof(value)='array' THEN
  SELECT coalesce(jsonb_agg(ai_distill.remove_material_version_fields(item) ORDER BY ordinality),'[]'::jsonb) INTO cleaned
  FROM jsonb_array_elements(value) WITH ORDINALITY AS entry(item,ordinality);
  RETURN cleaned;
 END IF;
 RETURN value;
END;
$$;
UPDATE ai_distill.step_attempts SET input=ai_distill.remove_material_version_fields(input),result=ai_distill.remove_material_version_fields(result);
UPDATE ai_distill.steps SET result=ai_distill.remove_material_version_fields(result);
UPDATE ai_distill.revision_rounds SET before_versions=ai_distill.remove_material_version_fields(before_versions),after_versions=ai_distill.remove_material_version_fields(after_versions),evidence=ai_distill.remove_material_version_fields(evidence);
DROP FUNCTION ai_distill.remove_material_version_fields(jsonb);

-- 不使用 CASCADE；若目标库存在未登记的额外依赖，整份事务应失败而不是扩大删除范围。
ALTER TABLE ai_distill.workflows DROP COLUMN input_revision;
ALTER TABLE ai_distill.materials DROP COLUMN input_revision;
ALTER TABLE ai_distill.step_attempts DROP COLUMN input_revision;
ALTER TABLE ai_distill.revision_chains DROP COLUMN input_revision;
ALTER TABLE ai_distill.project_exports DROP COLUMN workflow_revisions;
