-- 手动返修建议任务：独立于步骤及已撤除的自动返修链；只新增结构，不改题目/答案/分数。
CREATE TABLE ai_distill.revision_advice_attempts (
 id uuid PRIMARY KEY,
 workflow_id uuid NOT NULL REFERENCES ai_distill.workflows(id) ON DELETE CASCADE,
 project_id uuid NOT NULL REFERENCES ai_distill.projects(id) ON DELETE CASCADE,
 status text NOT NULL CHECK(status IN ('waiting','running','succeeded','failed','skipped')),
 source_digest text NOT NULL,
 input jsonb NOT NULL,
 config jsonb NOT NULL,
 result jsonb,
 error text,
 started_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz
);
CREATE INDEX revision_advice_workflow ON ai_distill.revision_advice_attempts(workflow_id,started_at DESC);
CREATE UNIQUE INDEX revision_advice_active ON ai_distill.revision_advice_attempts(workflow_id) WHERE status IN ('waiting','running');
ALTER TABLE ai_distill.execution_dispatches DROP CONSTRAINT execution_dispatches_job_kind_check;
ALTER TABLE ai_distill.execution_dispatches ADD CONSTRAINT execution_dispatches_job_kind_check CHECK(job_kind IN ('step','skill','library','hook','remote','advice'));
CREATE TRIGGER execution_owner_guard BEFORE UPDATE ON ai_distill.revision_advice_attempts FOR EACH ROW EXECUTE FUNCTION ai_distill.guard_execution_owner();
