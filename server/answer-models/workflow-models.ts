/**
 * 职责：未来任务切换模型时，旧题评分、判定与交付仍使用本轮答案冻结的模型集合。
 * 入口：readWorkflowModelSet供达标/归档/作答发布校验使用；未开启保留模式沿用项目集合。
 * 边界：只接受摘要校验通过的持久化作答快照，不拼接历史集合或重新解释旧分数。
 */
import type {Pool,PoolClient} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {answerModelSetDigest,readProjectModelSet,validateModelSet} from './model-set';
export async function readWorkflowModelSet(db:Pool|PoolClient,projectId:string,workflowId:string){
 try{
  const settings=await db.query('SELECT config FROM ai_distill.project_step_configs WHERE project_id=$1 AND ordinal=5',[projectId]);
  if(settings.rows[0]?.config?.preserve_answer_model_snapshots!==true)return await readProjectModelSet(db,projectId);
  const row=(await db.query(`SELECT a.input FROM ai_distill.step_attempts a
   JOIN ai_distill.steps s ON s.workflow_id=a.workflow_id AND s.ordinal=5
   WHERE a.workflow_id=$1 AND a.ordinal=5 AND a.input ? 'model_set'
    AND (s.result->>'model_set_digest' IS NULL OR a.input->>'model_set_digest'=s.result->>'model_set_digest')
   ORDER BY a.attempt DESC LIMIT 1`,[workflowId])).rows[0];
  if(!row){
   const legacy=await db.query('SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=5 LIMIT 1',[workflowId]);
   const previous=settings.rows[0]?.config?.previous_answer_models;
   if(legacy.rowCount&&Array.isArray(previous))return previous.length?validateModelSet(previous):[];
   return await readProjectModelSet(db,projectId);
  }
  const models=validateModelSet(row.input.model_set);
  if(answerModelSetDigest(models)!==row.input.model_set_digest)throw new HTTPException(409,{message:'作答冻结模型集合摘要不一致'});
  return models;
 }catch(error){throw error;}
}
