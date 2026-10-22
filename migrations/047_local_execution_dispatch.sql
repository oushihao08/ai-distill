-- 每机SQLite执行队列的业务归属登记；不移动历史尝试、不自动接管旧队列。
CREATE TABLE IF NOT EXISTS ai_distill.execution_dispatches (
 job_id uuid PRIMARY KEY,
 generation integer NOT NULL DEFAULT 0 CHECK(generation>=0),
 job_kind text NOT NULL CHECK(job_kind IN ('step','skill','library','hook','remote')),
 executor_id uuid NOT NULL,
 lane text NOT NULL CHECK(lane IN ('agent','api','internal','hook','remote')),
 route text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS execution_dispatches_owner ON ai_distill.execution_dispatches(executor_id,job_id);

-- 防止未升级的消费者领取或回收已归属其他执行节点的任务。
-- application_name是受信任本地服务的执行归属，不是数据库授权或网络认证。
CREATE OR REPLACE FUNCTION ai_distill.guard_execution_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id uuid; next_row jsonb; old_row jsonb;
BEGIN
 SELECT executor_id INTO owner_id FROM ai_distill.execution_dispatches WHERE job_id=OLD.id;
 IF owner_id IS NULL OR current_setting('application_name',true)='ai-distill-executor:'||owner_id::text THEN RETURN NEW; END IF;
 next_row=to_jsonb(NEW);old_row=to_jsonb(OLD);
 -- 业务输入失效和明确取消可跨节点通知；不允许借此更新心跳或覆盖结果。
 IF next_row->>'status' IN ('skipped','cancelled') AND next_row->'result' IS NOT DISTINCT FROM old_row->'result' THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='library_jobs' AND next_row->>'cancel_requested_at' IS NOT NULL
  AND (next_row-'cancel_requested_at'-'result_summary')=(old_row-'cancel_requested_at'-'result_summary') THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'execution belongs to another executor' USING ERRCODE='55000';
END $$;
DO $$
DECLARE name text;
BEGIN
 FOREACH name IN ARRAY ARRAY['step_attempts','project_skill_attempts','library_jobs','hook_runs','remote_material_operations'] LOOP
  IF to_regclass('ai_distill.'||name) IS NOT NULL THEN
   EXECUTE format('DROP TRIGGER IF EXISTS execution_owner_guard ON ai_distill.%I',name);
   EXECUTE format('CREATE TRIGGER execution_owner_guard BEFORE UPDATE ON ai_distill.%I FOR EACH ROW EXECUTE FUNCTION ai_distill.guard_execution_owner()',name);
  END IF;
 END LOOP;
END $$;
