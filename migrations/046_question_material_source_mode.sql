-- Per-period authoring chooses a frozen redacted or extracted-original source.
ALTER TABLE ai_distill.project_library_packages
  DROP CONSTRAINT project_library_packages_selected_pair,
  ADD CONSTRAINT project_library_packages_selected_revision_required
    CHECK (selected_redaction_id IS NULL OR selected_revision_id IS NOT NULL);

ALTER TABLE ai_distill.question_library_sources
  ALTER COLUMN redaction_id DROP NOT NULL,
  ADD COLUMN material_mode text NOT NULL DEFAULT 'redacted'
    CHECK (material_mode IN ('redacted','original')),
  ADD CONSTRAINT question_library_sources_material_mode_pair
    CHECK ((material_mode='redacted' AND redaction_id IS NOT NULL) OR (material_mode='original' AND redaction_id IS NULL));

CREATE INDEX question_library_sources_mode ON ai_distill.question_library_sources(material_mode,package_id,revision_id);

-- Keep the existing source-identity checks while accepting either a complete
-- usable redaction or a complete successful extraction snapshot.
CREATE OR REPLACE FUNCTION ai_distill.validate_question_library_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE backend text; workflow_kind text; markdown_kind text; index_kind text; package_deleted timestamptz; relation_removed timestamptz; project_deleted timestamptz; selected_revision uuid; selected_redaction uuid; usable boolean; actual_source_digest text; extraction_job uuid; expected_files integer; actual_files integer;
BEGIN
  SELECT p.material_backend,w.workflow_kind,lp.deleted_at,l.removed_at,p.deleted_at,l.selected_revision_id,l.selected_redaction_id
    INTO backend,workflow_kind,package_deleted,relation_removed,project_deleted,selected_revision,selected_redaction
    FROM ai_distill.projects p JOIN ai_distill.workflows w ON w.project_id=p.id
    JOIN ai_distill.project_library_packages l ON l.id=NEW.project_material_id AND l.project_id=p.id AND l.package_id=NEW.package_id
    JOIN ai_distill.library_packages lp ON lp.id=l.package_id
    WHERE p.id=NEW.project_id AND w.id=NEW.workflow_id;
  IF backend IS NULL OR workflow_kind IS DISTINCT FROM 'question' THEN
    RAISE EXCEPTION 'library source requires an active project question workflow' USING ERRCODE='23514';
  END IF;
  IF package_deleted IS NOT NULL OR relation_removed IS NOT NULL OR project_deleted IS NOT NULL THEN
    RAISE EXCEPTION 'new question source cannot use archived package or removed link' USING ERRCODE='23514';
  END IF;
  IF selected_revision IS DISTINCT FROM NEW.revision_id OR selected_redaction IS DISTINCT FROM NEW.redaction_id THEN
    RAISE EXCEPTION 'question source must match currently selected revision and redaction' USING ERRCODE='23514';
  END IF;

  IF NEW.material_mode='redacted' THEN
    SELECT validation_report->>'usable_for_question'='true',output_digest INTO usable,actual_source_digest
      FROM ai_distill.library_redactions WHERE id=NEW.redaction_id AND revision_id=NEW.revision_id;
    IF usable IS DISTINCT FROM true OR actual_source_digest IS DISTINCT FROM NEW.source_digest THEN
      RAISE EXCEPTION 'question source requires usable matching redaction' USING ERRCODE='23514';
    END IF;
  ELSE
    IF NEW.redaction_id IS NOT NULL OR NEW.source_digest !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'original question source requires an extraction digest without a redaction' USING ERRCODE='23514';
    END IF;
    SELECT r.file_count,j.id INTO expected_files,extraction_job
      FROM ai_distill.library_revisions r JOIN ai_distill.library_jobs j ON j.revision_id=r.id AND j.kind='extract' AND j.status='succeeded'
      WHERE r.id=NEW.revision_id AND r.package_id=NEW.package_id AND r.state='ready'
      ORDER BY j.finished_at DESC,j.id DESC LIMIT 1;
    SELECT count(*)::integer INTO actual_files FROM ai_distill.library_documents
      WHERE revision_id=NEW.revision_id AND extraction_job_id=extraction_job;
    IF extraction_job IS NULL OR expected_files IS NULL OR expected_files<1 OR actual_files<>expected_files THEN
      RAISE EXCEPTION 'question source requires complete successful extraction' USING ERRCODE='23514';
    END IF;
  END IF;

  SELECT kind INTO markdown_kind FROM ai_distill.artifacts WHERE workflow_id=NEW.workflow_id AND id=NEW.markdown_artifact_id;
  SELECT kind INTO index_kind FROM ai_distill.artifacts WHERE workflow_id=NEW.workflow_id AND id=NEW.index_artifact_id;
  IF NEW.material_mode='original' THEN
    IF markdown_kind IS DISTINCT FROM 'source_markdown' OR index_kind IS DISTINCT FROM 'source_index' THEN
      RAISE EXCEPTION 'original question source requires matching private source artifacts' USING ERRCODE='23514';
    END IF;
  ELSIF markdown_kind IS DISTINCT FROM 'redacted_markdown' OR index_kind IS DISTINCT FROM 'redacted_index' THEN
    RAISE EXCEPTION 'redacted question source requires matching private redacted artifacts' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
