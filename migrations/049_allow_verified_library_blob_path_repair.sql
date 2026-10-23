CREATE OR REPLACE FUNCTION ai_distill.guard_library_immutable_rows() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='library_blobs' THEN
    IF TG_OP='UPDATE'
      AND OLD.storage_kind='file'
      AND NEW.storage_kind='file'
      AND (to_jsonb(NEW)-'storage_path') IS NOT DISTINCT FROM (to_jsonb(OLD)-'storage_path')
      AND NEW.storage_path IS DISTINCT FROM OLD.storage_path THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME USING ERRCODE='55000';
  END IF;
  IF TG_TABLE_NAME IN ('library_files','library_documents','library_redactions') THEN
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
