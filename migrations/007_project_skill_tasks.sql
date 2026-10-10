-- 文件职责：建立项目级 skill 生成尝试、快照及持久化队列。
CREATE TABLE ai_distill.project_skill_attempts (
 id uuid PRIMARY KEY,
 project_id uuid NOT NULL REFERENCES ai_distill.projects(id),
 status text NOT NULL CHECK (status IN ('waiting','running','succeeded','failed','skipped')),
 input jsonb NOT NULL,
 config jsonb NOT NULL,
 result jsonb,
 error text,
 session_id text,
 created_at timestamptz NOT NULL DEFAULT now(),
 started_at timestamptz,
 heartbeat_at timestamptz,
 finished_at timestamptz
);
CREATE UNIQUE INDEX project_skill_one_active ON ai_distill.project_skill_attempts(project_id) WHERE status IN ('waiting','running');
CREATE INDEX project_skill_queue ON ai_distill.project_skill_attempts(created_at,id) WHERE status IN ('waiting','running');
