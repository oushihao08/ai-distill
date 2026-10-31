-- 重新部署原子入库的延迟完整性函数；不改表、不回写历史任务。
CREATE OR REPLACE FUNCTION ai_distill.require_extracted_library_insert() RETURNS trigger LANGUAGE plpgsql AS $$
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
 IF NOT valid THEN RAISE EXCEPTION 'complete extraction is required before creating library material records'
  USING ERRCODE='23514',CONSTRAINT=TG_NAME; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION ai_distill.require_extracted_library_file() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE valid boolean;
BEGIN
 IF TG_TABLE_NAME='library_blobs' AND NEW.storage_kind<>'file' THEN RETURN NEW; END IF;
 SELECT EXISTS(SELECT 1 FROM ai_distill.library_files f
  JOIN ai_distill.library_revisions r ON r.id=f.revision_id AND r.state='ready'
  JOIN ai_distill.library_documents d ON d.file_id=f.id AND d.revision_id=r.id
  JOIN ai_distill.library_jobs j ON j.id=d.extraction_job_id AND j.revision_id=r.id AND j.kind='extract' AND j.status='succeeded'
  WHERE (TG_TABLE_NAME='library_files' AND f.id=NEW.id) OR (TG_TABLE_NAME='library_blobs' AND f.blob_id=NEW.id)) INTO valid;
 IF NOT valid THEN RAISE EXCEPTION 'source file requires a successfully extracted library document'
  USING ERRCODE='23514',CONSTRAINT=TG_NAME; END IF;
 RETURN NEW;
END $$;
