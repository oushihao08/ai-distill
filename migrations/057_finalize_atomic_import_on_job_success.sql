-- 去除原子导入中“插入包时反查后续成功任务”的循环约束，改由任务成功事件统一核对最终状态。
DROP TRIGGER library_package_requires_extraction ON ai_distill.library_packages;
DROP TRIGGER library_revision_requires_extraction ON ai_distill.library_revisions;
DROP TRIGGER library_file_requires_extraction ON ai_distill.library_files;
DROP TRIGGER library_source_blob_requires_extraction ON ai_distill.library_blobs;

DROP FUNCTION ai_distill.require_extracted_library_package();
DROP FUNCTION ai_distill.require_extracted_library_revision();
DROP FUNCTION ai_distill.require_extracted_library_file_row();
DROP FUNCTION ai_distill.require_extracted_library_source_blob();

CREATE OR REPLACE FUNCTION ai_distill.validate_library_job_success() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_files integer; actual_files integer; actual_documents integer; output_count integer; usable boolean; revision_ready boolean; package_current boolean;
BEGIN
 IF NEW.status='succeeded' THEN
  SELECT r.file_count,r.state='ready',p.current_revision_id=r.id
   INTO expected_files,revision_ready,package_current
   FROM ai_distill.library_revisions r JOIN ai_distill.library_packages p ON p.id=r.package_id
   WHERE r.id=NEW.revision_id AND r.package_id=NEW.package_id;
  IF NEW.kind='extract' THEN
   SELECT count(*) INTO actual_documents FROM ai_distill.library_documents WHERE extraction_job_id=NEW.id;
   IF NEW.input_snapshot ? 'atomic_import' THEN
    SELECT count(*) INTO actual_files FROM ai_distill.library_files WHERE revision_id=NEW.revision_id;
    IF revision_ready IS DISTINCT FROM true OR package_current IS DISTINCT FROM true
      OR actual_files<>expected_files OR actual_documents<>expected_files THEN
     RAISE EXCEPTION 'successful atomic extract job is incomplete' USING ERRCODE='23514',CONSTRAINT=TG_NAME;
    END IF;
   ELSIF actual_documents<>expected_files THEN
    RAISE EXCEPTION 'successful extract job is incomplete' USING ERRCODE='23514',CONSTRAINT=TG_NAME;
   END IF;
  ELSIF NEW.kind='redact' THEN
   SELECT count(*),bool_and(validation_report->>'usable_for_question'='true') INTO output_count,usable
    FROM ai_distill.library_redactions WHERE redaction_job_id=NEW.id;
   IF output_count<>1 OR usable IS DISTINCT FROM true THEN RAISE EXCEPTION 'successful redact job requires one usable published result' USING ERRCODE='23514'; END IF;
  ELSIF NEW.kind='intake' THEN
   IF revision_ready IS DISTINCT FROM true THEN RAISE EXCEPTION 'successful intake job must seal its revision' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
