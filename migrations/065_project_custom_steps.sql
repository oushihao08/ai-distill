-- 项目级隔离定制步骤运行表：与基础表 ai_distill.steps（ordinal 1..10）物理分表，未注册定制步骤的项目零查询、零影响。
-- 支持单次步骤（sub_run_key='main'）与多子运行步骤（如 ALE 8+1 的 cal_run_01..08 / demo_run_01，支持 8 路并发，每次子运行独立占 1 个队列槽位）。
-- repair_evaluation 强制为结构化 JSON 对象（jsonb_typeof = 'object'），用于承载失败/早停后的结构化返修诊断与增量返修输入。
CREATE TABLE IF NOT EXISTS ai_distill.custom_step_runs (
 id uuid PRIMARY KEY,
 workflow_id uuid NOT NULL REFERENCES ai_distill.workflows(id) ON DELETE CASCADE,
 project_id uuid NOT NULL REFERENCES ai_distill.projects(id) ON DELETE CASCADE,
 project_key text NOT NULL CHECK (btrim(project_key) <> ''),
 step_key text NOT NULL CHECK (btrim(step_key) <> ''),
 anchor_ordinal integer NOT NULL CHECK (anchor_ordinal BETWEEN 1 AND 10),
 placement text NOT NULL CHECK (placement IN ('before','after')),
 step_order integer NOT NULL CHECK (step_order >= 1),
 sub_run_key text NOT NULL DEFAULT 'main' CHECK (btrim(sub_run_key) <> ''),
 lane text NOT NULL CHECK (lane IN ('internal','agent','api')),
 execution_target text NOT NULL DEFAULT 'local' CHECK (execution_target IN ('local','server')),
 status text NOT NULL CHECK (status IN ('waiting','running','succeeded','failed','skipped','cancelled')),
 source_digest text NOT NULL CHECK (btrim(source_digest) <> ''),
 input jsonb NOT NULL DEFAULT '{}'::jsonb,
 config jsonb NOT NULL DEFAULT '{}'::jsonb,
 result jsonb,
 repair_evaluation jsonb CHECK (repair_evaluation IS NULL OR jsonb_typeof(repair_evaluation) = 'object'),
 error text,
 started_at timestamptz NOT NULL DEFAULT now(),
 heartbeat_at timestamptz,
 finished_at timestamptz
);

ALTER TABLE ai_distill.custom_step_runs
 ADD COLUMN IF NOT EXISTS repair_evaluation jsonb CHECK (repair_evaluation IS NULL OR jsonb_typeof(repair_evaluation) = 'object');

CREATE INDEX IF NOT EXISTS custom_step_runs_workflow ON ai_distill.custom_step_runs(workflow_id, step_key, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS custom_step_runs_active ON ai_distill.custom_step_runs(workflow_id, step_key, sub_run_key) WHERE status IN ('waiting','running');

ALTER TABLE ai_distill.execution_dispatches DROP CONSTRAINT IF EXISTS execution_dispatches_job_kind_check;
ALTER TABLE ai_distill.execution_dispatches ADD CONSTRAINT execution_dispatches_job_kind_check CHECK (job_kind IN ('step','skill','library','hook','remote','advice','custom_step'));

DROP TRIGGER IF EXISTS execution_owner_guard ON ai_distill.custom_step_runs;
CREATE TRIGGER execution_owner_guard BEFORE UPDATE ON ai_distill.custom_step_runs FOR EACH ROW EXECUTE FUNCTION ai_distill.guard_execution_owner();
