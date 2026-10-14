-- 项目阶段钩子的执行记录与主操作检查点；不改变业务步骤身份或历史尝试。
CREATE TABLE ai_distill.hook_runs (
 id uuid PRIMARY KEY,
 workflow_id uuid NOT NULL,
 attempt_id uuid NOT NULL,
 stage text NOT NULL CHECK (stage IN ('authoring','answer','scoring')),
 position text NOT NULL CHECK (position IN ('before','after','main')),
 action_id text NOT NULL,
 mode text NOT NULL CHECK (mode IN ('sync','async','checkpoint')),
 status text NOT NULL CHECK (status IN ('waiting','running','succeeded','failed','cancelled','needs_review')),
 binding_digest text NOT NULL,
 snapshot jsonb NOT NULL,
 result jsonb,
 result_digest text,
 history jsonb NOT NULL DEFAULT '[]'::jsonb,
 error text,
 idempotent boolean NOT NULL DEFAULT false,
 heartbeat_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 started_at timestamptz,
 finished_at timestamptz,
 FOREIGN KEY (workflow_id,attempt_id) REFERENCES ai_distill.step_attempts(workflow_id,id) ON DELETE CASCADE,
 UNIQUE (attempt_id,position,action_id),
 CHECK ((position='main' AND mode='checkpoint') OR (position<>'main' AND mode<>'checkpoint'))
);
CREATE INDEX hook_runs_pending ON ai_distill.hook_runs(created_at,id) WHERE mode='async' AND status IN ('waiting','running');
CREATE INDEX hook_runs_workflow ON ai_distill.hook_runs(workflow_id,attempt_id);
