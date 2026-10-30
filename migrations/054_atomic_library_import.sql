-- 新导入仅登记任务；完整提取成功后在同一事务绑定包/版本并发布全部材料。
-- 不删除或重写历史材料，不回填历史失败记录；API/worker须一起加载新代码。
ALTER TABLE ai_distill.library_jobs ALTER COLUMN package_id DROP NOT NULL;
ALTER TABLE ai_distill.library_jobs ALTER COLUMN revision_id DROP NOT NULL;
ALTER TABLE ai_distill.library_jobs ADD CONSTRAINT library_job_staged_identity CHECK (
 (package_id IS NOT NULL AND revision_id IS NOT NULL) OR
 (package_id IS NULL AND revision_id IS NULL AND kind='extract' AND status<>'succeeded'
  AND jsonb_typeof(input_snapshot->'atomic_import') IS NOT DISTINCT FROM 'object')
);
CREATE UNIQUE INDEX library_atomic_import_request ON ai_distill.library_jobs(request_key)
 WHERE input_snapshot ? 'atomic_import';

CREATE FUNCTION ai_distill.guard_atomic_library_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mutable text[]:=ARRAY['status','progress','result_summary','error_code','error_message','lease_token','lease_expires_at','heartbeat_at','cancel_requested_at','started_at','deadline_at','finished_at'];
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'library jobs are immutable' USING ERRCODE='55000'; END IF;
 -- 仅允许本次任务在发布事务中一次性绑定预先冻结的身份；其余输入仍不可变。
 IF OLD.package_id IS NULL AND OLD.revision_id IS NULL AND OLD.kind='extract' AND OLD.status='running' AND NEW.status='running'
  AND NEW.package_id::text=OLD.input_snapshot#>>'{atomic_import,package_id}'
  AND NEW.revision_id::text=OLD.input_snapshot#>>'{atomic_import,revision_id}' THEN
  mutable:=mutable||ARRAY['package_id','revision_id'];
 END IF;
 IF (to_jsonb(NEW)-mutable) IS DISTINCT FROM (to_jsonb(OLD)-mutable) THEN RAISE EXCEPTION 'library job input is immutable' USING ERRCODE='55000'; END IF;
 IF NOT ((OLD.status='queued' AND NEW.status IN ('running','failed','cancelled')) OR
  (OLD.status='running' AND NEW.status IN ('succeeded','failed','cancelled')) OR OLD.status=NEW.status) THEN
  RAISE EXCEPTION 'invalid library job state transition' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER library_jobs_transition ON ai_distill.library_jobs;
CREATE TRIGGER library_jobs_transition BEFORE UPDATE OR DELETE ON ai_distill.library_jobs
 FOR EACH ROW EXECUTE FUNCTION ai_distill.guard_atomic_library_job();

-- 数据库兜底：旧客户端/旧服务也不能提交未完成提取的新包、新版本或新原件记录。
CREATE FUNCTION ai_distill.require_extracted_library_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; valid boolean;
BEGIN
 IF TG_TABLE_NAME='library_packages' THEN target:=NEW.id;
 ELSE target:=NEW.package_id; END IF;
 SELECT EXISTS(SELECT 1 FROM ai_distill.library_revisions r
  JOIN ai_distill.library_jobs j ON j.revision_id=r.id AND j.kind='extract' AND j.status='succeeded'
  WHERE r.package_id=target AND r.state='ready' AND r.file_count>0
   AND (TG_TABLE_NAME='library_packages' OR r.id=NEW.id)
   AND (SELECT count(*) FROM ai_distill.library_documents d WHERE d.revision_id=r.id AND d.extraction_job_id=j.id)=r.file_count)
 INTO valid;
 IF NOT valid THEN RAISE EXCEPTION 'complete extraction is required before creating library material records' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER library_package_requires_extraction AFTER INSERT ON ai_distill.library_packages
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ai_distill.require_extracted_library_insert();
CREATE CONSTRAINT TRIGGER library_revision_requires_extraction AFTER INSERT ON ai_distill.library_revisions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ai_distill.require_extracted_library_insert();

CREATE FUNCTION ai_distill.require_extracted_library_file() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE valid boolean;
BEGIN
 IF TG_TABLE_NAME='library_blobs' THEN
  IF NEW.storage_kind<>'file' THEN RETURN NEW; END IF;
 END IF;
 SELECT EXISTS(SELECT 1 FROM ai_distill.library_files f
  JOIN ai_distill.library_revisions r ON r.id=f.revision_id AND r.state='ready'
  JOIN ai_distill.library_documents d ON d.file_id=f.id AND d.revision_id=r.id
  JOIN ai_distill.library_jobs j ON j.id=d.extraction_job_id AND j.revision_id=r.id AND j.kind='extract' AND j.status='succeeded'
  WHERE (TG_TABLE_NAME='library_files' AND f.id=NEW.id) OR (TG_TABLE_NAME='library_blobs' AND f.blob_id=NEW.id)) INTO valid;
 IF NOT valid THEN RAISE EXCEPTION 'source file requires a successfully extracted library document' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER library_file_requires_extraction AFTER INSERT ON ai_distill.library_files
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ai_distill.require_extracted_library_file();
CREATE CONSTRAINT TRIGGER library_source_blob_requires_extraction AFTER INSERT ON ai_distill.library_blobs
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ai_distill.require_extracted_library_file();
