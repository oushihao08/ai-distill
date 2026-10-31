-- 原子入库的四类对象分别校验，避免共享函数依赖TG_TABLE_NAME分流。
CREATE FUNCTION ai_distill.require_extracted_library_package() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM ai_distill.library_revisions r
  JOIN ai_distill.library_jobs j ON j.revision_id=r.id AND j.kind='extract' AND j.status='succeeded'
  WHERE r.package_id=NEW.id AND r.state='ready' AND r.file_count>0
   AND (SELECT count(*) FROM ai_distill.library_documents d WHERE d.revision_id=r.id AND d.extraction_job_id=j.id)=r.file_count)
 THEN RAISE EXCEPTION 'complete extraction is required before creating a library package'
  USING ERRCODE='23514',CONSTRAINT=TG_NAME; END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION ai_distill.require_extracted_library_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM ai_distill.library_jobs j
  WHERE j.revision_id=NEW.id AND j.kind='extract' AND j.status='succeeded'
   AND NEW.state='ready' AND NEW.file_count>0
   AND (SELECT count(*) FROM ai_distill.library_documents d WHERE d.revision_id=NEW.id AND d.extraction_job_id=j.id)=NEW.file_count)
 THEN RAISE EXCEPTION 'complete extraction is required before creating a library revision'
  USING ERRCODE='23514',CONSTRAINT=TG_NAME; END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION ai_distill.require_extracted_library_file_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM ai_distill.library_revisions r
  JOIN ai_distill.library_documents d ON d.file_id=NEW.id AND d.revision_id=r.id
  JOIN ai_distill.library_jobs j ON j.id=d.extraction_job_id AND j.revision_id=r.id AND j.kind='extract' AND j.status='succeeded'
  WHERE r.id=NEW.revision_id AND r.state='ready')
 THEN RAISE EXCEPTION 'source file requires a successfully extracted library document'
  USING ERRCODE='23514',CONSTRAINT=TG_NAME; END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION ai_distill.require_extracted_library_source_blob() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.storage_kind<>'file' THEN RETURN NEW; END IF;
 IF NOT EXISTS(SELECT 1 FROM ai_distill.library_files f
  JOIN ai_distill.library_revisions r ON r.id=f.revision_id AND r.state='ready'
  JOIN ai_distill.library_documents d ON d.file_id=f.id AND d.revision_id=r.id
  JOIN ai_distill.library_jobs j ON j.id=d.extraction_job_id AND j.revision_id=r.id AND j.kind='extract' AND j.status='succeeded'
  WHERE f.blob_id=NEW.id)
 THEN RAISE EXCEPTION 'source blob requires a successfully extracted library document'
  USING ERRCODE='23514',CONSTRAINT=TG_NAME; END IF;
 RETURN NEW;
END $$;

DROP TRIGGER library_package_requires_extraction ON ai_distill.library_packages;
DROP TRIGGER library_revision_requires_extraction ON ai_distill.library_revisions;
DROP TRIGGER library_file_requires_extraction ON ai_distill.library_files;
DROP TRIGGER library_source_blob_requires_extraction ON ai_distill.library_blobs;

CREATE CONSTRAINT TRIGGER library_package_requires_extraction AFTER INSERT ON ai_distill.library_packages
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ai_distill.require_extracted_library_package();
CREATE CONSTRAINT TRIGGER library_revision_requires_extraction AFTER INSERT ON ai_distill.library_revisions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ai_distill.require_extracted_library_revision();
CREATE CONSTRAINT TRIGGER library_file_requires_extraction AFTER INSERT ON ai_distill.library_files
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ai_distill.require_extracted_library_file_row();
CREATE CONSTRAINT TRIGGER library_source_blob_requires_extraction AFTER INSERT ON ai_distill.library_blobs
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ai_distill.require_extracted_library_source_blob();

DROP FUNCTION ai_distill.require_extracted_library_insert();
DROP FUNCTION ai_distill.require_extracted_library_file();
