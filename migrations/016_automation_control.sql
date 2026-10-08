CREATE TABLE ai_distill.automation_batches (
 id uuid PRIMARY KEY,
 project_id uuid NOT NULL REFERENCES ai_distill.projects(id),
 mode text NOT NULL CHECK(mode IN ('horizontal','vertical')),
 status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','paused','cancelled','completed','blocked')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai_distill.automation_members (
 workflow_id uuid NOT NULL REFERENCES ai_distill.workflows(id),
 batch_id uuid NOT NULL REFERENCES ai_distill.automation_batches(id),
 input_revision integer NOT NULL,
 status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','blocked','completed','cancelled')),
 reason text,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(batch_id,workflow_id)
);
CREATE INDEX automation_members_batch ON ai_distill.automation_members(batch_id);
CREATE UNIQUE INDEX automation_members_active_workflow ON ai_distill.automation_members(workflow_id) WHERE status IN ('running','blocked');
ALTER TABLE ai_distill.projects ADD COLUMN execution_paused boolean NOT NULL DEFAULT false;
CREATE TABLE ai_distill.executor_blocks (
 executor text PRIMARY KEY,
 reason text NOT NULL CHECK(reason IN ('authentication','quota')),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION ai_distill.dispatch_allowed(target uuid, executor_key text) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id
 WHERE w.id=target AND NOT p.execution_paused AND p.deleted_at IS NULL AND w.deleted_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM ai_distill.automation_members m JOIN ai_distill.automation_batches b ON b.id=m.batch_id
 WHERE m.workflow_id=target AND m.batch_id=(SELECT m2.batch_id FROM ai_distill.automation_members m2 JOIN ai_distill.automation_batches b2 ON b2.id=m2.batch_id WHERE m2.workflow_id=target ORDER BY b2.created_at DESC,b2.id DESC LIMIT 1) AND (b.status IN ('paused','cancelled') OR m.status='cancelled'))
 AND NOT EXISTS(SELECT 1 FROM ai_distill.executor_blocks WHERE executor=executor_key)
$$;
