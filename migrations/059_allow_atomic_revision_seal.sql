-- 原子导入没有独立intake任务；完整性由057的提取任务成功门禁校验。
CREATE OR REPLACE FUNCTION ai_distill.validate_library_revision_sealed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE intake_status text; intake_kind text; intake_manifest text; actual_files integer; min_position integer; max_position integer;
BEGIN
 IF NEW.state='ready' THEN
  IF NEW.source_info->>'kind'='atomic_import' THEN RETURN NEW; END IF;
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
