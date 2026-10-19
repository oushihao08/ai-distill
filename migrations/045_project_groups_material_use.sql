-- 文件职责：建立稳定主项目、独立期次与不随题目删除的材料使用账；不改写题目及执行结果。
CREATE TABLE ai_distill.project_groups (
 id uuid PRIMARY KEY,
 name text NOT NULL UNIQUE CHECK(length(btrim(name)) BETWEEN 1 AND 120),
 created_at timestamptz NOT NULL DEFAULT now(),
 deleted_at timestamptz
);
-- parent_name是已显式登记的主项目归属；沿用每组最小UUID，不新增扩展或猜测期号。
INSERT INTO ai_distill.project_groups(id,name)
 SELECT min(id::text)::uuid,parent_name FROM ai_distill.projects GROUP BY parent_name;
ALTER TABLE ai_distill.projects ADD COLUMN project_group_id uuid REFERENCES ai_distill.project_groups(id) ON DELETE RESTRICT;
ALTER TABLE ai_distill.projects ADD COLUMN phase_no integer CHECK(phase_no>0);
UPDATE ai_distill.projects p SET project_group_id=g.id FROM ai_distill.project_groups g WHERE g.name=p.parent_name;
ALTER TABLE ai_distill.projects ALTER COLUMN project_group_id SET NOT NULL;
ALTER TABLE ai_distill.projects ADD CONSTRAINT projects_group_identity UNIQUE(project_group_id,id);
CREATE UNIQUE INDEX projects_group_phase_no ON ai_distill.projects(project_group_id,phase_no) WHERE phase_no IS NOT NULL;
-- 只识别已明确登记的第五期；首批筹备由后续受控衔接操作设为第一期。
UPDATE ai_distill.projects p SET phase_no=5 WHERE parent_name='豆包高经济价值' AND phase_name='第五期'
 AND NOT EXISTS(SELECT 1 FROM ai_distill.projects q WHERE q.project_group_id=p.project_group_id AND q.phase_name='第五期' AND q.id<>p.id);

CREATE TABLE ai_distill.project_material_uses (
 id uuid PRIMARY KEY,
 project_group_id uuid NOT NULL REFERENCES ai_distill.project_groups(id) ON DELETE RESTRICT,
 package_id uuid NOT NULL REFERENCES ai_distill.library_packages(id) ON DELETE RESTRICT,
 owner_phase_id uuid NOT NULL,
 material_signature text NOT NULL CHECK(material_signature ~ '^[a-f0-9]{64}$'),
 status text NOT NULL DEFAULT 'in_use' CHECK(status IN ('in_use','submitted')),
 first_used_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 lock_version integer NOT NULL DEFAULT 1 CHECK(lock_version>0),
 FOREIGN KEY(project_group_id,owner_phase_id) REFERENCES ai_distill.projects(project_group_id,id) ON DELETE RESTRICT,
 UNIQUE(project_group_id,package_id),
 UNIQUE(project_group_id,material_signature)
);
CREATE INDEX project_material_uses_owner ON ai_distill.project_material_uses(owner_phase_id,id);
CREATE TABLE ai_distill.project_material_use_events (
 id uuid PRIMARY KEY,
 use_id uuid NOT NULL REFERENCES ai_distill.project_material_uses(id) ON DELETE RESTRICT,
 event_type text NOT NULL CHECK(event_type IN ('loaded','submitted','reopened','legacy_import')),
 previous_status text CHECK(previous_status IN ('in_use','submitted')),
 status text NOT NULL CHECK(status IN ('in_use','submitted')),
 reason text NOT NULL DEFAULT '',
 evidence jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(evidence)='object'),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_material_use_events_history ON ai_distill.project_material_use_events(use_id,created_at,id);
ALTER TABLE ai_distill.library_jobs ADD COLUMN origin text NOT NULL DEFAULT 'execution' CHECK(origin IN ('execution','legacy_import'));
CREATE CONSTRAINT TRIGGER library_import_job_success_complete AFTER INSERT ON ai_distill.library_jobs
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ai_distill.validate_library_job_success();
ALTER TABLE ai_distill.project_library_packages ADD COLUMN material_use_id uuid REFERENCES ai_distill.project_material_uses(id) ON DELETE RESTRICT;

-- 与uses.ts的UTF-8签名相同；去掉改名/改序/重复附件造成的假新身份，不需要pgcrypto扩展。
CREATE FUNCTION ai_distill.library_revision_material_signature(revision uuid) RETURNS text LANGUAGE SQL STABLE AS $$
 SELECT CASE WHEN count(*)=0 THEN NULL ELSE encode(sha256(convert_to(
  '{"format":"material-set-v1","files":['||string_agg(to_json(identity)::text,',' ORDER BY identity)||']}', 'UTF8')),'hex') END
 FROM (SELECT DISTINCT b.sha256||':'||b.size_bytes::text AS identity FROM ai_distill.library_files f
  JOIN ai_distill.library_blobs b ON b.id=f.blob_id WHERE f.revision_id=revision) files
$$;
-- 旧加载也是已使用。按有时间证据的首次加载保留占用；重复历史不删除、不改写旧题。
WITH candidates AS (
 SELECT l.id,l.project_id,l.package_id,l.created_at,p.project_group_id,
  ai_distill.library_revision_material_signature(COALESCE(l.selected_revision_id,k.current_revision_id)) AS signature
 FROM ai_distill.project_library_packages l JOIN ai_distill.projects p ON p.id=l.project_id
 JOIN ai_distill.library_packages k ON k.id=l.package_id
), by_package AS (
 SELECT DISTINCT ON(project_group_id,package_id) * FROM candidates WHERE signature IS NOT NULL
 ORDER BY project_group_id,package_id,created_at,id
), by_material AS (
 SELECT DISTINCT ON(project_group_id,signature) * FROM by_package ORDER BY project_group_id,signature,created_at,id
)
INSERT INTO ai_distill.project_material_uses(id,project_group_id,package_id,owner_phase_id,material_signature,first_used_at)
 SELECT id,project_group_id,package_id,project_id,signature,created_at FROM by_material;
-- 旧触发器拒绝归档包/已隐藏期次的任何UPDATE；本次仅回填历史外键。
-- ALTER持有表锁，迁移事务提交前恢复触发器，失败回滚不会留下禁用状态。
ALTER TABLE ai_distill.project_library_packages DISABLE TRIGGER project_library_package_validate;
UPDATE ai_distill.project_library_packages l SET material_use_id=u.id
 FROM ai_distill.project_material_uses u,ai_distill.projects p,ai_distill.library_packages k
 WHERE p.id=l.project_id AND k.id=l.package_id AND p.project_group_id=u.project_group_id
 AND (l.package_id=u.package_id OR ai_distill.library_revision_material_signature(COALESCE(l.selected_revision_id,k.current_revision_id))=u.material_signature);
ALTER TABLE ai_distill.project_library_packages ENABLE TRIGGER project_library_package_validate;
INSERT INTO ai_distill.project_material_use_events(id,use_id,event_type,status,reason,evidence)
 SELECT u.id,u.id,'legacy_import','in_use','迁移前已有加载；按首次加载时间保留占用，不删除历史重复题目',
  jsonb_build_object('origin','migration_045','legacy_phase_ids',(SELECT jsonb_agg(DISTINCT l.project_id) FROM ai_distill.project_library_packages l WHERE l.material_use_id=u.id))
 FROM ai_distill.project_material_uses u;

-- 历史映射只关联来源，不切换旧题的执行读源；workflow/attempt标识不设级联外键。
CREATE TABLE ai_distill.legacy_material_imports (
 id uuid PRIMARY KEY,
 source_phase_id uuid NOT NULL REFERENCES ai_distill.projects(id) ON DELETE RESTRICT,
 source_workflow_id uuid NOT NULL,
 source_digest text NOT NULL CHECK(source_digest ~ '^[a-f0-9]{64}$'),
 package_id uuid NOT NULL REFERENCES ai_distill.library_packages(id) ON DELETE RESTRICT,
 revision_id uuid NOT NULL REFERENCES ai_distill.library_revisions(id) ON DELETE RESTRICT,
 use_id uuid REFERENCES ai_distill.project_material_uses(id) ON DELETE RESTRICT,
 manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(source_phase_id,source_workflow_id,source_digest)
);

CREATE FUNCTION ai_distill.protect_material_use_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'material use history cannot be deleted' USING ERRCODE='23514'; END IF;
 IF (NEW.project_group_id,NEW.package_id,NEW.owner_phase_id,NEW.material_signature,NEW.first_used_at)
  IS DISTINCT FROM (OLD.project_group_id,OLD.package_id,OLD.owner_phase_id,OLD.material_signature,OLD.first_used_at) THEN
  RAISE EXCEPTION 'material use identity is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER project_material_uses_identity BEFORE UPDATE OR DELETE ON ai_distill.project_material_uses
 FOR EACH ROW EXECUTE FUNCTION ai_distill.protect_material_use_identity();
CREATE TRIGGER project_material_use_events_immutable BEFORE UPDATE OR DELETE ON ai_distill.project_material_use_events
 FOR EACH ROW EXECUTE FUNCTION ai_distill.prevent_publication_event_mutation();

CREATE FUNCTION ai_distill.validate_loaded_material_use() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE u ai_distill.project_material_uses; gid uuid;
BEGIN
 SELECT project_group_id INTO gid FROM ai_distill.projects WHERE id=NEW.project_id;
 IF NEW.material_use_id IS NULL THEN
  RAISE EXCEPTION 'loaded material requires a persistent project use' USING ERRCODE='23514';
 END IF;
 SELECT * INTO u FROM ai_distill.project_material_uses WHERE id=NEW.material_use_id;
 IF u.id IS NULL OR u.project_group_id IS DISTINCT FROM gid OR u.owner_phase_id IS DISTINCT FROM NEW.project_id OR u.package_id IS DISTINCT FROM NEW.package_id THEN
  RAISE EXCEPTION 'loaded material use must belong to this project and phase' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
-- 现有加载先由后续服务核对后补使用账；触发器仅约束新加载或实际改选，不影响纯软移除。
CREATE TRIGGER loaded_material_use_binding BEFORE INSERT OR UPDATE OF selected_revision_id,selected_redaction_id,material_use_id
 ON ai_distill.project_library_packages FOR EACH ROW EXECUTE FUNCTION ai_distill.validate_loaded_material_use();

CREATE FUNCTION ai_distill.protect_project_group_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.project_group_id IS DISTINCT FROM OLD.project_group_id AND (
  EXISTS(SELECT 1 FROM ai_distill.workflows WHERE project_id=OLD.id)
  OR EXISTS(SELECT 1 FROM ai_distill.project_material_uses WHERE owner_phase_id=OLD.id)
  OR EXISTS(SELECT 1 FROM ai_distill.project_library_packages WHERE project_id=OLD.id)
 ) THEN RAISE EXCEPTION 'a used phase cannot move to another project' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER projects_group_membership BEFORE UPDATE OF project_group_id ON ai_distill.projects
 FOR EACH ROW EXECUTE FUNCTION ai_distill.protect_project_group_membership();
