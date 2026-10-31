/** 职责：显式修订豆包题目开头措辞及分类；HTTP/CLI调用，保留原尝试和冻结来源，生成新版本并使后续结果失效。 */
import type {Pool} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {createHash,randomUUID} from 'node:crypto';
import {renderPublicQuestionPackage} from './executor';
import {logEvent} from '../logging';

export async function reviseQuestionOpening(pool:Pool,workflowId:string,raw:unknown){
 const bad=(message:string)=>new HTTPException(400,{message});
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw bad('修订须为JSON对象');
 const v=raw as Record<string,unknown>;
 if(Object.keys(v).some(k=>!['expected_question_version','expected_rubric_version','opening_before','opening_after','reason','task_type'].includes(k)))throw bad('包含不支持的修订字段');
 for(const key of ['expected_question_version','expected_rubric_version','opening_before','opening_after','reason'])if(typeof v[key]!=='string'||!v[key].trim())throw bad(`缺少${key}`);
 if(String(v.opening_before).length>1200||String(v.opening_after).length>1200||String(v.reason).length>500)throw bad('修订开头或原因过长');
 if(v.task_type!==undefined&&(typeof v.task_type!=='string'||!v.task_type.trim()||v.task_type.trim().length>100))throw bad('任务类型须为1至100字符的非空文本');
 const db=await pool.connect();
 try{
  await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='2s'");
  const w=(await db.query(`SELECT w.project_id,w.title,p.parent_name FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id WHERE w.id=$1 AND w.deleted_at IS NULL AND p.deleted_at IS NULL AND w.workflow_kind='question' FOR UPDATE OF w`,[workflowId])).rows[0];
  if(!w)throw new HTTPException(404,{message:'题目不存在'});
  if(w.parent_name!=='豆包高经济价值')throw new HTTPException(409,{message:'当前修订入口仅适用于豆包项目'});
  // 同步与修订共用事务锁，防止外部写入期间题目变化。
  if(!(await db.query("SELECT pg_try_advisory_xact_lock(hashtext('feishu-workflow-v2'),hashtext($1)) AS locked",[workflowId])).rows[0]?.locked)throw new HTTPException(409,{message:'题目正在同步'});
  if((await db.query("SELECT 1 FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=8 AND status='succeeded'",[workflowId])).rowCount)throw new HTTPException(409,{message:'已归档题目须先撤回归档'});
  if((await db.query("SELECT 1 FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal BETWEEN 4 AND 8 AND status IN ('waiting','running')",[workflowId])).rowCount)throw new HTTPException(409,{message:'题目仍有活动尝试，请先核实并结束原任务'});
  const q=(await db.query("SELECT result FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=4 AND status='succeeded' FOR UPDATE",[workflowId])).rows[0]?.result;
  if(!q||q.question_version!==v.expected_question_version||q.rubric_version!==v.expected_rubric_version)throw new HTTPException(409,{message:'题目版本已变化'});
  if(typeof q.question!=='string'||!q.question.startsWith(String(v.opening_before)))throw new HTTPException(409,{message:'原开头不匹配'});
  const source=(await db.query("SELECT id,input,config FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=4 AND status='succeeded' AND result->>'question_version'=$2 AND result->>'rubric_version'=$3 ORDER BY attempt DESC LIMIT 1",[workflowId,q.question_version,q.rubric_version])).rows[0];
  if(!source)throw new HTTPException(409,{message:'缺少当前题目的冻结出题来源'});
  const question=String(v.opening_after)+q.question.slice(String(v.opening_before).length),taskType=typeof v.task_type==='string'?v.task_type.trim():q.task_type;
  if(question===q.question&&taskType===q.task_type){await db.query('COMMIT');return{changed:false,question_version:q.question_version};}
  const id=randomUUID(),version=createHash('sha256').update(JSON.stringify({question,attachment_ids:q.attachment_ids,answer_requirements:q.answer_requirements})).digest('hex');
  const result={...q,question,task_type:taskType,question_version:version,manual_revision:{attempt_id:id,source_attempt_id:source.id,previous_question_version:q.question_version,previous_rubric_version:q.rubric_version,before:{question:q.question,task_type:q.task_type},reason:v.reason,created_at:new Date().toISOString()}};
  await db.query(`INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input,config,result,finished_at) SELECT $1,$2,4,COALESCE(MAX(attempt),0)+1,'succeeded',$3,$4,$5,now() FROM ai_distill.step_attempts WHERE workflow_id=$2 AND ordinal=4`,[id,workflowId,JSON.stringify(source.input),JSON.stringify({...source.config,execution_kind:'manual_revision'}),JSON.stringify(result)]);
  const content=renderPublicQuestionPackage({question:w.title,project_name:'豆包高经济价值',source_files:source.input.source_files??[]},result);
  await db.query(`INSERT INTO ai_distill.artifacts(id,workflow_id,attempt_id,kind,storage_path,sha256,size_bytes,content) VALUES($1,$2,$3,'authored_question',$4,$5,$6,$7)`,[randomUUID(),workflowId,id,`${workflowId}/${id}/authored_question.md`,createHash('sha256').update(content).digest('hex'),Buffer.byteLength(content),content]);
  await db.query("UPDATE ai_distill.steps SET result=$2,error=NULL,finished_at=now() WHERE workflow_id=$1 AND ordinal=4",[workflowId,JSON.stringify(result)]);
  await db.query("UPDATE ai_distill.steps SET status='waiting',result=NULL,error=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal BETWEEN 5 AND 8",[workflowId]);
  await db.query("UPDATE ai_distill.workflows SET status='waiting' WHERE id=$1",[workflowId]);
  await db.query("UPDATE ai_distill.project_exports SET status='stale',error='题目已显式修订',finished_at=now() WHERE project_id=$1 AND (status='running' OR (status='succeeded' AND $2::uuid=ANY(workflow_ids)))",[w.project_id,workflowId]);
  await db.query('COMMIT');logEvent('authoring.revised',{level:'info',workflow_id:workflowId,attempt_id:id,operation:'revise_opening'});
  return{changed:true,attempt_id:id,question_version:version,rubric_version:q.rubric_version,invalidated_ordinals:[5,6,7,8]};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
