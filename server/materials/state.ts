/**
 * 职责：附件集合或脱敏配置变化后的状态失效处理，不维护材料版本号。
 * 关键入口：invalidateMaterialResults() 供附件变更事务调用；invalidateRedactionResults() 供步骤设置事务调用。
 * 保留附件与执行历史，取消活动任务并使依赖旧附件的当前步骤和导出失效。
 */
import type {PoolClient} from 'pg';
export async function invalidateMaterialResults(db:PoolClient,workflowId:string,keepAttemptId?:string){
 try{
  await db.query("UPDATE ai_distill.step_attempts SET status='skipped',error='附件已更新，任务失效',finished_at=now() WHERE workflow_id=$1 AND status IN ('waiting','running') AND ($2::uuid IS NULL OR id<>$2)",[workflowId,keepAttemptId??null]);
  await db.query("UPDATE ai_distill.steps SET status='waiting',result=NULL,error=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1",[workflowId]);
  await db.query("UPDATE ai_distill.project_exports SET status='stale',error='附件已更新',finished_at=now() WHERE project_id=(SELECT project_id FROM ai_distill.workflows WHERE id=$1) AND status IN ('running','succeeded') AND EXISTS(SELECT 1 FROM ai_distill.workflows w WHERE w.id=$1 AND w.workflow_kind='question')",[workflowId]);
  await db.query("UPDATE ai_distill.workflows SET status='waiting' WHERE id=$1",[workflowId]);
 }catch(error){throw error;}
}

/** 脱敏配置变更和恢复默认共用：锁定题目、取消旧任务，保留入库/提取并使脱敏及其下游失效。 */
export async function invalidateRedactionResults(db:PoolClient,projectId:string){
 try{
  await db.query('SELECT id FROM ai_distill.workflows WHERE project_id=$1 AND deleted_at IS NULL AND source_workflow_id IS NULL ORDER BY id FOR UPDATE',[projectId]);
  await db.query("UPDATE ai_distill.step_attempts SET status='skipped',error='脱敏设置已更新，原任务失效',finished_at=now() WHERE ordinal IN (4,5,6,7,8,9,10) AND status IN ('waiting','running') AND workflow_id IN (SELECT id FROM ai_distill.workflows WHERE project_id=$1 AND deleted_at IS NULL AND source_workflow_id IS NULL)",[projectId]);
  await db.query("UPDATE ai_distill.steps SET status='waiting',result=NULL,error=NULL,started_at=NULL,finished_at=NULL WHERE ordinal IN (4,5,6,7,8,9,10) AND workflow_id IN (SELECT id FROM ai_distill.workflows WHERE project_id=$1 AND deleted_at IS NULL AND source_workflow_id IS NULL)",[projectId]);
  await db.query("UPDATE ai_distill.workflows SET status='waiting' WHERE project_id=$1 AND deleted_at IS NULL AND source_workflow_id IS NULL",[projectId]);
  await db.query("UPDATE ai_distill.project_exports SET status='stale',error='脱敏设置已更新',finished_at=now() WHERE project_id=$1 AND status IN ('running','succeeded') AND EXISTS(SELECT 1 FROM ai_distill.projects p WHERE p.id=$1 AND p.material_mode='question_folders')",[projectId]);
 }catch(error){throw error;}
}
