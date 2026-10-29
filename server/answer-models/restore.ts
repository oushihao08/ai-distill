/** 显式恢复因配置变更丢失的步骤投影；HTTP调用，复用原成功答案/评分，不调用模型或修改历史attempt。 */
import type {Pool} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {refreshAnswerStep} from './jobs';
import {canonicalJson} from '../../shared/workflow-config';
import {refreshScoreStep} from '../scoring/jobs';
import {readScoreContext} from '../scoring/context';
export async function restoreAnswerScoreResults(pool:Pool,workflowId:string,answerOnly=false){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const workflow=(await db.query('SELECT id FROM ai_distill.workflows WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[workflowId])).rows[0];
  if(!workflow)throw new HTTPException(404,{message:'题目不存在'});
  if((await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal IN (5,6) AND status IN ('waiting','running')",[workflowId])).rowCount)throw new HTTPException(409,{message:'作答或评分仍有活动任务'});
  const author=(await db.query("SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=4 AND status='succeeded' ORDER BY attempt DESC LIMIT 1",[workflowId])).rows[0];
  const answer=(await db.query("SELECT * FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=5 AND status='succeeded' AND input->>'question_attempt_id'=$2 ORDER BY attempt DESC LIMIT 1",[workflowId,author?.id])).rows[0];
  if(!answer)throw new HTTPException(409,{message:'没有同版题目的成功答案可恢复'});
  await refreshAnswerStep(db,answer);
  const restored=(await db.query('SELECT status,result FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=5',[workflowId])).rows[0];
  if(restored?.status!=='succeeded')throw new HTTPException(409,{message:'本版模型答案尚未全部成功，不能恢复'});
  const answerIds=restored.result?.models?.map((m:any)=>m.attempt_id)??[answer.id];
  if(answerOnly){
   for(const id of answerIds)await readScoreContext(db,workflowId,id);
   await db.query('COMMIT');return{workflow_id:workflowId,answer_ids:answerIds,score_ids:[],restored:true,answer_only:true};
  }
  const scoreIds:string[]=[];
  for(const id of answerIds){
   const context=await readScoreContext(db,workflowId,id);
   const score=(await db.query("SELECT * FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=6 AND input #>> '{context,binding,answer_attempt_id}'=$2 ORDER BY attempt DESC LIMIT 1",[workflowId,id])).rows[0];
   if(score?.status!=='succeeded'||score.result?.validation?.valid!==true||canonicalJson(context.binding)!==canonicalJson(score.input?.context?.binding))throw new HTTPException(409,{message:'没有同版题面、答案及评分规则的有效评分可恢复'});
   scoreIds.push(score.id);
  }
  const status=await refreshScoreStep(db,{workflow_id:workflowId,status:'succeeded'});
  if(status!=='succeeded')throw new HTTPException(409,{message:'评分汇总未成功，恢复已回滚'});
  await db.query('COMMIT');return{workflow_id:workflowId,answer_ids:answerIds,score_ids:scoreIds,restored:true};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
