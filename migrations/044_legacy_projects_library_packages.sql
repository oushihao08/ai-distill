-- 文件职责：允许既有 legacy 项目加载全局材料包，并由单题来源快照决定新旧材料读取路径。
-- 兼容边界：不修改项目 material_backend、不改写旧题/附件/步骤；旧题仍走原步骤 1/9。

CREATE OR REPLACE FUNCTION ai_distill.validate_project_library_package() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE backend text; project_deleted timestamptz; package_deleted timestamptz; usable boolean;
BEGIN
  SELECT material_backend,deleted_at INTO backend,project_deleted FROM ai_distill.projects WHERE id=NEW.project_id;
  SELECT deleted_at INTO package_deleted FROM ai_distill.library_packages WHERE id=NEW.package_id;
  IF backend IS NULL OR project_deleted IS NOT NULL OR package_deleted IS NOT NULL THEN
    RAISE EXCEPTION 'only active projects may load an active package' USING ERRCODE='23514';
  END IF;
  IF NEW.selected_redaction_id IS NOT NULL THEN
    SELECT validation_report->>'usable_for_question'='true' INTO usable
      FROM ai_distill.library_redactions WHERE id=NEW.selected_redaction_id AND revision_id=NEW.selected_revision_id;
    IF usable IS DISTINCT FROM true THEN RAISE EXCEPTION 'selected library redaction is not usable for questions' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION ai_distill.validate_question_library_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE backend text; workflow_kind text; markdown_kind text; index_kind text; package_deleted timestamptz; relation_removed timestamptz; project_deleted timestamptz; selected_revision uuid; selected_redaction uuid; usable boolean; actual_source_digest text;
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
