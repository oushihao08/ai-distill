CREATE SCHEMA IF NOT EXISTS ai_distill;
CREATE TABLE ai_distill.projects (
 id uuid PRIMARY KEY, name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120), description text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai_distill.rule_versions (
 id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES ai_distill.projects(id), version integer NOT NULL, status text NOT NULL DEFAULT 'draft', manifest jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id, version)
);
CREATE TABLE ai_distill.workflows (
 id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES ai_distill.projects(id), request_id uuid NOT NULL, title text NOT NULL, status text NOT NULL DEFAULT 'waiting', rule_version_id uuid REFERENCES ai_distill.rule_versions(id), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id, request_id)
);
CREATE TABLE ai_distill.materials (
 id uuid PRIMARY KEY, workflow_id uuid NOT NULL REFERENCES ai_distill.workflows(id), original_name text NOT NULL, storage_path text NOT NULL, sha256 text NOT NULL, size_bytes bigint NOT NULL, content_type text NOT NULL DEFAULT 'unknown', processing_status text NOT NULL DEFAULT 'received', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai_distill.steps (
 workflow_id uuid NOT NULL REFERENCES ai_distill.workflows(id), ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 8), name text NOT NULL, status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','running','succeeded','failed','skipped')), implemented boolean NOT NULL DEFAULT false, result jsonb, error text, started_at timestamptz, finished_at timestamptz, PRIMARY KEY(workflow_id, ordinal)
);
CREATE TABLE ai_distill.step_attempts (
 id uuid PRIMARY KEY, workflow_id uuid NOT NULL, ordinal integer NOT NULL, attempt integer NOT NULL, status text NOT NULL CHECK (status IN ('waiting','running','succeeded','failed','skipped')), input jsonb NOT NULL DEFAULT '{}', result jsonb, error text, config jsonb NOT NULL DEFAULT '{}', session_id text, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, FOREIGN KEY(workflow_id, ordinal) REFERENCES ai_distill.steps(workflow_id, ordinal), UNIQUE(workflow_id, ordinal, attempt)
);
CREATE TABLE ai_distill.artifacts (
 id uuid PRIMARY KEY, workflow_id uuid NOT NULL REFERENCES ai_distill.workflows(id), material_id uuid REFERENCES ai_distill.materials(id), attempt_id uuid REFERENCES ai_distill.step_attempts(id), kind text NOT NULL, storage_path text NOT NULL, sha256 text NOT NULL, size_bytes bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflows_project_created ON ai_distill.workflows(project_id, created_at DESC);
CREATE INDEX materials_workflow ON ai_distill.materials(workflow_id);
CREATE INDEX attempts_workflow ON ai_distill.step_attempts(workflow_id, ordinal, attempt);
