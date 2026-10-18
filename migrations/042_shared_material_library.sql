-- 文件职责：新增独立共享材料库、项目加载关系和题目来源快照，不迁移或改写旧材料记录。
-- 迁移新增库级数据结构；应用层仍须校验摘要、冻结配置、租约和跨资源锁顺序。

ALTER TABLE ai_distill.projects
  ADD COLUMN material_backend text NOT NULL DEFAULT 'legacy'
    CHECK (material_backend IN ('legacy','library_v1')),
  ADD COLUMN workspace_path text,
  ADD CONSTRAINT projects_library_workspace_required
    CHECK (material_backend <> 'library_v1' OR (workspace_path IS NOT NULL AND length(trim(workspace_path)) > 0));

ALTER TABLE ai_distill.artifacts
  ADD CONSTRAINT artifacts_workflow_id_unique UNIQUE (workflow_id,id);

CREATE TABLE ai_distill.library_blobs (
  id uuid PRIMARY KEY,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  content_type text NOT NULL,
  storage_kind text NOT NULL CHECK (storage_kind IN ('file','database_text')),
  storage_target text,
  storage_path text,
  text_content text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT library_blobs_storage_shape CHECK (
    (storage_kind='file' AND storage_target IS NOT NULL AND storage_target IN ('local','server') AND storage_path IS NOT NULL AND length(storage_path)>0 AND text_content IS NULL)
    OR (storage_kind='database_text' AND storage_target IS NULL AND storage_path IS NULL AND text_content IS NOT NULL)
  ),
  CONSTRAINT library_blobs_text_size CHECK (storage_kind<>'database_text' OR size_bytes=octet_length(text_content))
);
CREATE UNIQUE INDEX library_blobs_file_digest_target ON ai_distill.library_blobs(sha256,storage_target) WHERE storage_kind='file';
CREATE UNIQUE INDEX library_blobs_text_digest_type ON ai_distill.library_blobs(sha256,content_type) WHERE storage_kind='database_text';
CREATE UNIQUE INDEX library_blobs_file_path ON ai_distill.library_blobs(storage_target,storage_path) WHERE storage_kind='file';

CREATE TABLE ai_distill.library_packages (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 180),
  description text NOT NULL DEFAULT '',
  tags text[] NOT NULL DEFAULT '{}',
  current_revision_id uuid,
  processing_settings jsonb NOT NULL,
  lock_version bigint NOT NULL DEFAULT 1 CHECK (lock_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT library_packages_id_revision_unique UNIQUE (id,current_revision_id)
);

CREATE TABLE ai_distill.library_revisions (
  id uuid PRIMARY KEY,
  package_id uuid NOT NULL REFERENCES ai_distill.library_packages(id) ON DELETE RESTRICT,
  parent_revision_id uuid,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ready')),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  file_count integer NOT NULL CHECK (file_count > 0),
  source_info jsonb NOT NULL,
  request_key uuid NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  sealed_at timestamptz,
  CONSTRAINT library_revisions_package_id_unique UNIQUE (package_id,id),
  CONSTRAINT library_revisions_package_request_unique UNIQUE (package_id,request_key),
  CONSTRAINT library_revisions_package_parent_fk FOREIGN KEY (package_id,parent_revision_id)
    REFERENCES ai_distill.library_revisions(package_id,id) ON DELETE RESTRICT,
  CONSTRAINT library_revisions_not_own_parent CHECK (parent_revision_id IS NULL OR parent_revision_id<>id),
  CONSTRAINT library_revisions_sealed_state CHECK ((state='pending' AND sealed_at IS NULL) OR (state='ready' AND sealed_at IS NOT NULL))
);
ALTER TABLE ai_distill.library_packages
  ADD CONSTRAINT library_packages_current_revision_fk
    FOREIGN KEY (id,current_revision_id) REFERENCES ai_distill.library_revisions(package_id,id)
    DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX library_revisions_package_created ON ai_distill.library_revisions(package_id,created_at DESC,id);

CREATE TABLE ai_distill.library_files (
  id uuid PRIMARY KEY,
  revision_id uuid NOT NULL REFERENCES ai_distill.library_revisions(id) ON DELETE RESTRICT,
  blob_id uuid NOT NULL REFERENCES ai_distill.library_blobs(id) ON DELETE RESTRICT,
  original_name text NOT NULL CHECK (length(trim(original_name))>0),
  position integer NOT NULL CHECK (position>0),
  redaction_mode text NOT NULL DEFAULT 'model' CHECK (redaction_mode IN ('model','declared_redacted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT library_files_revision_id_unique UNIQUE (revision_id,id),
  CONSTRAINT library_files_revision_position_unique UNIQUE (revision_id,position),
  CONSTRAINT library_files_revision_name_unique UNIQUE (revision_id,original_name)
);
CREATE INDEX library_files_blob_id ON ai_distill.library_files(blob_id);

CREATE FUNCTION ai_distill.validate_library_file_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE revision_state text; expected_files integer; actual_files integer;
BEGIN
  SELECT state,file_count INTO revision_state,expected_files FROM ai_distill.library_revisions WHERE id=NEW.revision_id;
  SELECT count(*) INTO actual_files FROM ai_distill.library_files WHERE revision_id=NEW.revision_id;
  IF revision_state IS DISTINCT FROM 'pending' OR actual_files>=expected_files THEN
    RAISE EXCEPTION 'files can only be added within the pending revision manifest' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER library_files_insert_guard BEFORE INSERT ON ai_distill.library_files
  FOR EACH ROW EXECUTE FUNCTION ai_distill.validate_library_file_insert();

CREATE TABLE ai_distill.library_jobs (
  id uuid PRIMARY KEY,
  package_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('intake','extract','redact')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  request_key uuid NOT NULL,
  previous_job_id uuid,
  input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  input_snapshot jsonb NOT NULL,
  config_digest text NOT NULL CHECK (config_digest ~ '^[a-f0-9]{64}$'),
  config_snapshot jsonb NOT NULL,
  executor_kind text NOT NULL CHECK (executor_kind IN ('internal','api','agent')),
  execution_target text NOT NULL CHECK (execution_target IN ('local','server')),
  progress jsonb NOT NULL DEFAULT '{}',
  result_summary jsonb NOT NULL DEFAULT '{}',
  error_code text,
  error_message text,
  lease_token uuid,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  cancel_requested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  deadline_at timestamptz,
  finished_at timestamptz,
  CONSTRAINT library_jobs_package_revision_fk FOREIGN KEY (package_id,revision_id)
    REFERENCES ai_distill.library_revisions(package_id,id) ON DELETE RESTRICT,
  CONSTRAINT library_jobs_revision_id_unique UNIQUE (revision_id,id),
  CONSTRAINT library_jobs_package_revision_kind_id_unique UNIQUE (package_id,revision_id,kind,id),
  CONSTRAINT library_jobs_package_request_unique UNIQUE (package_id,request_key),
  CONSTRAINT library_jobs_previous_job_fk FOREIGN KEY (package_id,revision_id,kind,previous_job_id)
    REFERENCES ai_distill.library_jobs(package_id,revision_id,kind,id) ON DELETE RESTRICT,
  CONSTRAINT library_jobs_executor_target CHECK (executor_kind<>'agent' OR execution_target='local'),
  CONSTRAINT library_jobs_executor_kind CHECK (
    (kind='intake' AND executor_kind='internal') OR
    (kind='extract' AND executor_kind IN ('internal','api')) OR
    (kind='redact' AND executor_kind IN ('internal','api','agent'))
  ),
  CONSTRAINT library_jobs_status_times CHECK (
    (status='queued' AND started_at IS NULL AND deadline_at IS NULL AND finished_at IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL AND heartbeat_at IS NULL)
    OR (status='running' AND started_at IS NOT NULL AND deadline_at IS NOT NULL AND finished_at IS NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND heartbeat_at IS NOT NULL)
    OR (status='succeeded' AND finished_at IS NOT NULL AND error_code IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL AND heartbeat_at IS NULL)
    OR (status='failed' AND finished_at IS NOT NULL AND error_code IS NOT NULL AND lease_token IS NULL AND lease_expires_at IS NULL AND heartbeat_at IS NULL)
    OR (status='cancelled' AND finished_at IS NOT NULL AND error_code IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL AND heartbeat_at IS NULL)
  )
);
CREATE UNIQUE INDEX library_jobs_one_active_per_revision ON ai_distill.library_jobs(revision_id) WHERE status IN ('queued','running');
CREATE INDEX library_jobs_consume ON ai_distill.library_jobs(execution_target,executor_kind,created_at,id) WHERE status='queued';
CREATE INDEX library_jobs_history ON ai_distill.library_jobs(package_id,kind,created_at DESC,id);
CREATE INDEX library_jobs_expired_lease ON ai_distill.library_jobs(lease_expires_at) WHERE status='running';

CREATE TABLE ai_distill.library_documents (
  id uuid PRIMARY KEY,
  revision_id uuid NOT NULL,
  file_id uuid NOT NULL,
  extraction_job_id uuid NOT NULL,
  document_blob_id uuid NOT NULL REFERENCES ai_distill.library_blobs(id) ON DELETE RESTRICT,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  text_sha256 text NOT NULL CHECK (text_sha256 ~ '^[a-f0-9]{64}$'),
  page_count integer NOT NULL CHECK (page_count>=1),
  issues jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT library_documents_file_fk FOREIGN KEY (revision_id,file_id)
    REFERENCES ai_distill.library_files(revision_id,id) ON DELETE RESTRICT,
  CONSTRAINT library_documents_job_fk FOREIGN KEY (revision_id,extraction_job_id)
    REFERENCES ai_distill.library_jobs(revision_id,id) ON DELETE RESTRICT,
  CONSTRAINT library_documents_job_file_unique UNIQUE (extraction_job_id,file_id)
);

CREATE TABLE ai_distill.library_redactions (
  id uuid PRIMARY KEY,
  package_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  extraction_job_id uuid NOT NULL,
  redaction_job_id uuid NOT NULL UNIQUE,
  markdown_blob_id uuid NOT NULL REFERENCES ai_distill.library_blobs(id) ON DELETE RESTRICT,
  index_blob_id uuid NOT NULL REFERENCES ai_distill.library_blobs(id) ON DELETE RESTRICT,
  input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  output_digest text NOT NULL CHECK (output_digest ~ '^[a-f0-9]{64}$'),
  validation_report jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT library_redactions_package_revision_fk FOREIGN KEY (package_id,revision_id)
    REFERENCES ai_distill.library_revisions(package_id,id) ON DELETE RESTRICT,
  CONSTRAINT library_redactions_revision_id_unique UNIQUE (revision_id,id),
  CONSTRAINT library_redactions_extract_job_fk FOREIGN KEY (revision_id,extraction_job_id)
    REFERENCES ai_distill.library_jobs(revision_id,id) ON DELETE RESTRICT,
  CONSTRAINT library_redactions_redact_job_fk FOREIGN KEY (revision_id,redaction_job_id)
    REFERENCES ai_distill.library_jobs(revision_id,id) ON DELETE RESTRICT,
  CONSTRAINT library_redactions_extract_job_distinct CHECK (extraction_job_id<>redaction_job_id)
);

CREATE TABLE ai_distill.project_library_packages (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES ai_distill.projects(id) ON DELETE RESTRICT,
  package_id uuid NOT NULL REFERENCES ai_distill.library_packages(id) ON DELETE RESTRICT,
  selected_revision_id uuid,
  selected_redaction_id uuid,
  position integer NOT NULL CHECK (position>0),
  lock_version bigint NOT NULL DEFAULT 1 CHECK (lock_version>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  CONSTRAINT project_library_packages_selected_pair CHECK ((selected_revision_id IS NULL)=(selected_redaction_id IS NULL)),
  CONSTRAINT project_library_packages_package_revision_fk FOREIGN KEY (package_id,selected_revision_id)
    REFERENCES ai_distill.library_revisions(package_id,id) ON DELETE RESTRICT,
  CONSTRAINT project_library_packages_redaction_fk FOREIGN KEY (selected_revision_id,selected_redaction_id)
    REFERENCES ai_distill.library_redactions(revision_id,id) ON DELETE RESTRICT,
  CONSTRAINT project_library_packages_id_project_package_unique UNIQUE (id,project_id,package_id)
);
CREATE UNIQUE INDEX project_library_packages_active_unique ON ai_distill.project_library_packages(project_id,package_id) WHERE removed_at IS NULL;
CREATE INDEX project_library_packages_project_position ON ai_distill.project_library_packages(project_id,position,id) WHERE removed_at IS NULL;

CREATE TABLE ai_distill.question_library_sources (
  workflow_id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  project_material_id uuid NOT NULL,
  package_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  redaction_id uuid NOT NULL,
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  snapshot_manifest jsonb NOT NULL,
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^[a-f0-9]{64}$'),
  markdown_artifact_id uuid NOT NULL,
  index_artifact_id uuid NOT NULL,
  request_key uuid NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT question_library_sources_project_workflow_fk FOREIGN KEY (project_id,workflow_id)
    REFERENCES ai_distill.workflows(project_id,id) ON DELETE CASCADE,
  CONSTRAINT question_library_sources_loaded_package_fk FOREIGN KEY (project_material_id,project_id,package_id)
    REFERENCES ai_distill.project_library_packages(id,project_id,package_id) ON DELETE RESTRICT,
  CONSTRAINT question_library_sources_package_revision_fk FOREIGN KEY (package_id,revision_id)
    REFERENCES ai_distill.library_revisions(package_id,id) ON DELETE RESTRICT,
  CONSTRAINT question_library_sources_revision_redaction_fk FOREIGN KEY (revision_id,redaction_id)
    REFERENCES ai_distill.library_redactions(revision_id,id) ON DELETE RESTRICT,
  CONSTRAINT question_library_sources_markdown_artifact_fk FOREIGN KEY (workflow_id,markdown_artifact_id)
    REFERENCES ai_distill.artifacts(workflow_id,id) ON DELETE RESTRICT,
  CONSTRAINT question_library_sources_index_artifact_fk FOREIGN KEY (workflow_id,index_artifact_id)
    REFERENCES ai_distill.artifacts(workflow_id,id) ON DELETE RESTRICT,
  CONSTRAINT question_library_sources_request_unique UNIQUE (project_id,request_key),
  CONSTRAINT question_library_sources_artifacts_distinct CHECK (markdown_artifact_id<>index_artifact_id)
);
CREATE INDEX question_library_sources_package_revision ON ai_distill.question_library_sources(package_id,revision_id,redaction_id);

CREATE FUNCTION ai_distill.guard_library_immutable_rows() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME IN ('library_blobs','library_files','library_documents','library_redactions') THEN
    RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE='55000';
  END IF;
  IF TG_TABLE_NAME='library_revisions' THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'library revisions are immutable' USING ERRCODE='55000'; END IF;
    IF (to_jsonb(NEW)-'state'-'sealed_at') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'sealed_at')
      OR NOT (OLD.state='pending' AND NEW.state='ready' AND OLD.sealed_at IS NULL AND NEW.sealed_at IS NOT NULL) THEN
      RAISE EXCEPTION 'only pending to ready revision sealing is allowed' USING ERRCODE='55000';
    END IF;
  END IF;
  IF TG_TABLE_NAME='library_jobs' THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'library jobs are immutable' USING ERRCODE='55000'; END IF;
    IF (to_jsonb(NEW)-ARRAY['status','progress','result_summary','error_code','error_message','lease_token','lease_expires_at','heartbeat_at','cancel_requested_at','started_at','deadline_at','finished_at'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','progress','result_summary','error_code','error_message','lease_token','lease_expires_at','heartbeat_at','cancel_requested_at','started_at','deadline_at','finished_at']) THEN
      RAISE EXCEPTION 'library job input is immutable' USING ERRCODE='55000';
    END IF;
    IF NOT ((OLD.status='queued' AND NEW.status IN ('running','failed','cancelled')) OR
      (OLD.status='running' AND NEW.status IN ('succeeded','failed','cancelled')) OR OLD.status=NEW.status) THEN
      RAISE EXCEPTION 'invalid library job state transition: % to %',OLD.status,NEW.status USING ERRCODE='55000';
    END IF;
  END IF;
  IF TG_TABLE_NAME='question_library_sources' THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'question library source snapshots are immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER library_blobs_immutable BEFORE UPDATE OR DELETE ON ai_distill.library_blobs FOR EACH ROW EXECUTE FUNCTION ai_distill.guard_library_immutable_rows();
CREATE TRIGGER library_files_immutable BEFORE UPDATE OR DELETE ON ai_distill.library_files FOR EACH ROW EXECUTE FUNCTION ai_distill.guard_library_immutable_rows();
CREATE TRIGGER library_documents_immutable BEFORE UPDATE OR DELETE ON ai_distill.library_documents FOR EACH ROW EXECUTE FUNCTION ai_distill.guard_library_immutable_rows();
CREATE TRIGGER library_redactions_immutable BEFORE UPDATE OR DELETE ON ai_distill.library_redactions FOR EACH ROW EXECUTE FUNCTION ai_distill.guard_library_immutable_rows();
CREATE TRIGGER library_revisions_transition BEFORE UPDATE OR DELETE ON ai_distill.library_revisions FOR EACH ROW EXECUTE FUNCTION ai_distill.guard_library_immutable_rows();
CREATE TRIGGER library_jobs_transition BEFORE UPDATE OR DELETE ON ai_distill.library_jobs FOR EACH ROW EXECUTE FUNCTION ai_distill.guard_library_immutable_rows();
CREATE TRIGGER question_library_sources_immutable BEFORE UPDATE OR DELETE ON ai_distill.question_library_sources FOR EACH ROW EXECUTE FUNCTION ai_distill.guard_library_immutable_rows();

CREATE FUNCTION ai_distill.validate_library_revision_sealed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE intake_status text; intake_kind text; intake_manifest text; actual_files integer; min_position integer; max_position integer;
BEGIN
  IF NEW.state='ready' THEN
    SELECT kind,status,input_snapshot->>'manifest_sha256' INTO intake_kind,intake_status,intake_manifest
      FROM ai_distill.library_jobs WHERE revision_id=NEW.id AND kind='intake' ORDER BY created_at DESC LIMIT 1;
    SELECT count(*),min(position),max(position) INTO actual_files,min_position,max_position FROM ai_distill.library_files WHERE revision_id=NEW.id;
    IF intake_kind IS DISTINCT FROM 'intake' OR intake_status IS DISTINCT FROM 'succeeded'
      OR intake_manifest IS DISTINCT FROM NEW.manifest_sha256 OR actual_files<>NEW.file_count OR min_position<>1 OR max_position<>NEW.file_count THEN
      RAISE EXCEPTION 'ready revision requires matching successful intake and complete file manifest' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER library_revision_sealed AFTER UPDATE OF state ON ai_distill.library_revisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ai_distill.validate_library_revision_sealed();

CREATE FUNCTION ai_distill.validate_project_library_package() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE backend text; project_deleted timestamptz; package_deleted timestamptz; usable boolean;
BEGIN
  SELECT material_backend,deleted_at INTO backend,project_deleted FROM ai_distill.projects WHERE id=NEW.project_id;
  SELECT deleted_at INTO package_deleted FROM ai_distill.library_packages WHERE id=NEW.package_id;
  IF backend IS DISTINCT FROM 'library_v1' OR project_deleted IS NOT NULL OR package_deleted IS NOT NULL THEN
    RAISE EXCEPTION 'only active library_v1 projects may load an active package' USING ERRCODE='23514';
  END IF;
  IF NEW.selected_redaction_id IS NOT NULL THEN
    SELECT validation_report->>'usable_for_question'='true' INTO usable
      FROM ai_distill.library_redactions WHERE id=NEW.selected_redaction_id AND revision_id=NEW.selected_revision_id;
    IF usable IS DISTINCT FROM true THEN RAISE EXCEPTION 'selected library redaction is not usable for questions' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER project_library_package_validate BEFORE INSERT OR UPDATE ON ai_distill.project_library_packages
  FOR EACH ROW EXECUTE FUNCTION ai_distill.validate_project_library_package();

CREATE FUNCTION ai_distill.validate_library_document_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job_kind text; blob_kind text;
BEGIN
  SELECT kind INTO job_kind FROM ai_distill.library_jobs WHERE id=NEW.extraction_job_id AND revision_id=NEW.revision_id;
  IF job_kind IS DISTINCT FROM 'extract' THEN RAISE EXCEPTION 'library document requires extract job' USING ERRCODE='23514'; END IF;
  SELECT storage_kind INTO blob_kind FROM ai_distill.library_blobs WHERE id=NEW.document_blob_id;
  IF blob_kind IS DISTINCT FROM 'database_text' THEN RAISE EXCEPTION 'extracted document must be a database text blob' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER library_documents_job_kind BEFORE INSERT ON ai_distill.library_documents FOR EACH ROW EXECUTE FUNCTION ai_distill.validate_library_document_job();

CREATE FUNCTION ai_distill.validate_library_documents_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE job_kind text; job_status text; expected_files integer; actual_files integer;
BEGIN
  SELECT kind,status INTO job_kind,job_status FROM ai_distill.library_jobs WHERE id=NEW.extraction_job_id AND revision_id=NEW.revision_id;
  SELECT file_count INTO expected_files FROM ai_distill.library_revisions WHERE id=NEW.revision_id;
  SELECT count(*) INTO actual_files FROM ai_distill.library_documents WHERE extraction_job_id=NEW.extraction_job_id;
  IF job_kind IS DISTINCT FROM 'extract' OR job_status IS DISTINCT FROM 'succeeded' OR actual_files<>expected_files THEN
    RAISE EXCEPTION 'successful extract job must contain every revision document' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER library_documents_complete AFTER INSERT ON ai_distill.library_documents
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ai_distill.validate_library_documents_complete();

CREATE FUNCTION ai_distill.validate_library_redaction_jobs() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE extraction_kind text; redaction_kind text; markdown_kind text; index_kind text;
BEGIN
  SELECT kind INTO extraction_kind FROM ai_distill.library_jobs WHERE id=NEW.extraction_job_id AND revision_id=NEW.revision_id;
  SELECT kind INTO redaction_kind FROM ai_distill.library_jobs WHERE id=NEW.redaction_job_id AND revision_id=NEW.revision_id;
  IF extraction_kind IS DISTINCT FROM 'extract' OR redaction_kind IS DISTINCT FROM 'redact' THEN
    RAISE EXCEPTION 'library redaction references wrong job kinds' USING ERRCODE='23514';
  END IF;
  SELECT storage_kind INTO markdown_kind FROM ai_distill.library_blobs WHERE id=NEW.markdown_blob_id;
  SELECT storage_kind INTO index_kind FROM ai_distill.library_blobs WHERE id=NEW.index_blob_id;
  IF markdown_kind IS DISTINCT FROM 'database_text' OR index_kind IS DISTINCT FROM 'database_text' THEN
    RAISE EXCEPTION 'redaction markdown and index must be database text blobs' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER library_redactions_job_kind BEFORE INSERT ON ai_distill.library_redactions FOR EACH ROW EXECUTE FUNCTION ai_distill.validate_library_redaction_jobs();

CREATE FUNCTION ai_distill.validate_library_redaction_published() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE extraction_status text; redaction_status text; redaction_digest text; usable boolean;
BEGIN
  SELECT status INTO extraction_status FROM ai_distill.library_jobs WHERE id=NEW.extraction_job_id AND revision_id=NEW.revision_id;
  SELECT status,input_digest INTO redaction_status,redaction_digest FROM ai_distill.library_jobs WHERE id=NEW.redaction_job_id AND revision_id=NEW.revision_id;
  usable := NEW.validation_report->>'usable_for_question'='true';
  IF extraction_status IS DISTINCT FROM 'succeeded' OR redaction_status IS DISTINCT FROM 'succeeded'
    OR NEW.input_digest IS DISTINCT FROM redaction_digest OR usable IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'published redaction must be usable and match successful frozen jobs' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER library_redactions_published AFTER INSERT ON ai_distill.library_redactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ai_distill.validate_library_redaction_published();

CREATE FUNCTION ai_distill.validate_library_job_success() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_files integer; actual_files integer; output_count integer; usable boolean;
BEGIN
  IF NEW.status='succeeded' THEN
    SELECT file_count INTO expected_files FROM ai_distill.library_revisions WHERE id=NEW.revision_id;
    IF NEW.kind='extract' THEN
      SELECT count(*) INTO actual_files FROM ai_distill.library_documents WHERE extraction_job_id=NEW.id;
      IF actual_files<>expected_files THEN RAISE EXCEPTION 'successful extract job is incomplete' USING ERRCODE='23514'; END IF;
    ELSIF NEW.kind='redact' THEN
      SELECT count(*),bool_and(validation_report->>'usable_for_question'='true') INTO output_count,usable
        FROM ai_distill.library_redactions WHERE redaction_job_id=NEW.id;
      IF output_count<>1 OR usable IS DISTINCT FROM true THEN RAISE EXCEPTION 'successful redact job requires one usable published result' USING ERRCODE='23514'; END IF;
    ELSIF NEW.kind='intake' THEN
      IF NOT EXISTS(SELECT 1 FROM ai_distill.library_revisions r WHERE r.id=NEW.revision_id AND r.state='ready') THEN
        RAISE EXCEPTION 'successful intake job must seal its revision' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER library_job_success_complete AFTER UPDATE OF status ON ai_distill.library_jobs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ai_distill.validate_library_job_success();

CREATE FUNCTION ai_distill.validate_question_library_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE backend text; workflow_kind text; markdown_kind text; index_kind text; package_deleted timestamptz; relation_removed timestamptz; project_deleted timestamptz; selected_revision uuid; selected_redaction uuid; usable boolean; actual_source_digest text;
BEGIN
  SELECT p.material_backend,w.workflow_kind,lp.deleted_at,l.removed_at,p.deleted_at,l.selected_revision_id,l.selected_redaction_id
    INTO backend,workflow_kind,package_deleted,relation_removed,project_deleted,selected_revision,selected_redaction
    FROM ai_distill.projects p JOIN ai_distill.workflows w ON w.project_id=p.id
    JOIN ai_distill.project_library_packages l ON l.id=NEW.project_material_id AND l.project_id=p.id AND l.package_id=NEW.package_id
    JOIN ai_distill.library_packages lp ON lp.id=l.package_id
    WHERE p.id=NEW.project_id AND w.id=NEW.workflow_id;
  IF backend IS DISTINCT FROM 'library_v1' OR workflow_kind IS DISTINCT FROM 'question' THEN
    RAISE EXCEPTION 'library source requires library_v1 question workflow' USING ERRCODE='23514';
  END IF;
  IF package_deleted IS NOT NULL OR relation_removed IS NOT NULL OR project_deleted IS NOT NULL THEN
    RAISE EXCEPTION 'new question source cannot use archived package or removed link' USING ERRCODE='23514';
  END IF;
  IF selected_revision IS DISTINCT FROM NEW.revision_id OR selected_redaction IS DISTINCT FROM NEW.redaction_id THEN
    RAISE EXCEPTION 'question source must match currently selected revision and redaction' USING ERRCODE='23514';
  END IF;
  SELECT validation_report->>'usable_for_question'='true',output_digest INTO usable,actual_source_digest
    FROM ai_distill.library_redactions WHERE id=NEW.redaction_id AND revision_id=NEW.revision_id;
  IF usable IS DISTINCT FROM true OR actual_source_digest IS DISTINCT FROM NEW.source_digest THEN
    RAISE EXCEPTION 'question source requires usable matching redaction' USING ERRCODE='23514';
  END IF;
  SELECT kind INTO markdown_kind FROM ai_distill.artifacts WHERE workflow_id=NEW.workflow_id AND id=NEW.markdown_artifact_id;
  SELECT kind INTO index_kind FROM ai_distill.artifacts WHERE workflow_id=NEW.workflow_id AND id=NEW.index_artifact_id;
  IF markdown_kind IS DISTINCT FROM 'redacted_markdown' OR index_kind IS DISTINCT FROM 'redacted_index' THEN
    RAISE EXCEPTION 'question library source requires redacted private artifacts' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER question_library_source_validate BEFORE INSERT ON ai_distill.question_library_sources FOR EACH ROW EXECUTE FUNCTION ai_distill.validate_question_library_source();
