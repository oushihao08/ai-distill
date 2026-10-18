-- 归档事件独立保留，撤回只改变当前步骤状态，不删除此前归档证据或交付文件。
CREATE TABLE ai_distill.workflow_publication_events (
  id uuid PRIMARY KEY,
  -- Keep identity values without workflow/attempt foreign keys: project cleanup may remove
  -- those operational rows, while this immutable audit record must remain queryable.
  workflow_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES ai_distill.projects(id) ON DELETE RESTRICT,
  attempt_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('archived','withdrawn')),
  provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_publication_events_provenance_object CHECK (jsonb_typeof(provenance)='object')
);
CREATE INDEX workflow_publication_events_workflow_history
  ON ai_distill.workflow_publication_events(workflow_id,created_at DESC,id);
CREATE INDEX workflow_publication_events_project_history
  ON ai_distill.workflow_publication_events(project_id,created_at DESC,id);
CREATE INDEX workflow_publication_events_library_package
  ON ai_distill.workflow_publication_events((provenance->'material_origin'->>'package_id'),created_at DESC)
  WHERE provenance->'material_origin'->>'kind'='library_v1';

CREATE FUNCTION ai_distill.validate_publication_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE workflow_project uuid; attempt_workflow uuid; attempt_ordinal integer; attempt_status text;
BEGIN
  SELECT project_id INTO workflow_project FROM ai_distill.workflows WHERE id=NEW.workflow_id;
  SELECT workflow_id,ordinal,status INTO attempt_workflow,attempt_ordinal,attempt_status
    FROM ai_distill.step_attempts WHERE id=NEW.attempt_id;
  IF workflow_project IS DISTINCT FROM NEW.project_id OR attempt_workflow IS DISTINCT FROM NEW.workflow_id
     OR attempt_ordinal IS DISTINCT FROM 8 OR attempt_status IS DISTINCT FROM 'succeeded' THEN
    RAISE EXCEPTION 'publication event must match a successful archive attempt for this workflow and project' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_publication_events_binding
  BEFORE INSERT ON ai_distill.workflow_publication_events
  FOR EACH ROW EXECUTE FUNCTION ai_distill.validate_publication_event();

CREATE FUNCTION ai_distill.prevent_publication_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'publication events are immutable' USING ERRCODE='55000';
END $$;
CREATE TRIGGER workflow_publication_events_immutable
  BEFORE UPDATE OR DELETE ON ai_distill.workflow_publication_events
  FOR EACH ROW EXECUTE FUNCTION ai_distill.prevent_publication_event_mutation();
