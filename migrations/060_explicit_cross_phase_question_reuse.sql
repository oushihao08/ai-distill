-- 文件职责：允许显式绑定原期成功题目的跨期材料复用，同时保留普通加载的主项目防重。
-- 仅加载关系记录例外来源与新方向；永久使用账仍由原期持有，不转移或释放占用。
ALTER TABLE ai_distill.project_library_packages
 ADD COLUMN reuse_source_workflow_id uuid,
 ADD COLUMN reuse_direction text,
 ADD CONSTRAINT loaded_material_reuse_pair CHECK ((reuse_source_workflow_id IS NULL) = (reuse_direction IS NULL)),
 ADD CONSTRAINT loaded_material_reuse_direction CHECK (reuse_direction IS NULL OR length(btrim(reuse_direction)) BETWEEN 1 AND 10000);

CREATE OR REPLACE FUNCTION ai_distill.validate_loaded_material_use() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE u ai_distill.project_material_uses; gid uuid; source_project uuid; source_direction text;
BEGIN
 SELECT project_group_id INTO gid FROM ai_distill.projects WHERE id=NEW.project_id;
 IF NEW.material_use_id IS NULL THEN
  RAISE EXCEPTION 'loaded material requires a persistent project use' USING ERRCODE='23514';
 END IF;
 SELECT * INTO u FROM ai_distill.project_material_uses WHERE id=NEW.material_use_id;
 IF u.id IS NULL OR u.project_group_id IS DISTINCT FROM gid OR u.package_id IS DISTINCT FROM NEW.package_id THEN
  RAISE EXCEPTION 'loaded material use must belong to this project group and package' USING ERRCODE='23514';
 END IF;
 IF u.owner_phase_id=NEW.project_id THEN
  IF NEW.reuse_source_workflow_id IS NOT NULL THEN
   RAISE EXCEPTION 'same-phase load cannot claim cross-phase reuse' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.reuse_source_workflow_id IS NULL OR NEW.reuse_direction IS NULL THEN
  RAISE EXCEPTION 'cross-phase load requires explicit source question and direction' USING ERRCODE='23514';
 END IF;
 SELECT w.project_id,w.authoring_direction INTO source_project,source_direction
 FROM ai_distill.workflows w
 JOIN ai_distill.question_library_sources q ON q.workflow_id=w.id AND q.package_id=NEW.package_id
 JOIN ai_distill.steps s ON s.workflow_id=w.id AND s.ordinal=4 AND s.status='succeeded'
 WHERE w.id=NEW.reuse_source_workflow_id AND w.deleted_at IS NULL;
 IF source_project IS DISTINCT FROM u.owner_phase_id OR btrim(NEW.reuse_direction)=btrim(COALESCE(source_direction,'')) THEN
  RAISE EXCEPTION 'cross-phase reuse source or new direction is invalid' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;

-- 防止事后改写例外来源；新题方向在建题请求中再次核对并冻结。
CREATE FUNCTION ai_distill.protect_loaded_material_reuse() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.reuse_source_workflow_id,NEW.reuse_direction) IS DISTINCT FROM (OLD.reuse_source_workflow_id,OLD.reuse_direction) THEN
  RAISE EXCEPTION 'cross-phase reuse source and direction are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER loaded_material_reuse_identity BEFORE UPDATE OF reuse_source_workflow_id,reuse_direction
 ON ai_distill.project_library_packages FOR EACH ROW EXECUTE FUNCTION ai_distill.protect_loaded_material_reuse();
