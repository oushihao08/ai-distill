import type {Pool} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {uuid} from '../validation';
import {planWorkflow,planBatch,type WorkflowPlan} from './planner';
import {enqueueIngestion,enqueueIntake} from '../intake-jobs';
import {enqueueExtraction} from '../materials/jobs';
import {enqueueRedaction} from '../materials/redaction-jobs';
import {loadWorkflowRules} from '../rule-loading';
import {enqueueAuthoring} from '../authoring/jobs';
import {enqueueAnswer} from '../answer-models/jobs';
import {enqueueScore} from '../scoring/jobs';
import {runAcceptance} from '../decisions/jobs';
import {startRevision,resumeRevision} from '../decisions/revision-jobs';
import {publishWorkflow} from '../publishing/jobs';
import {enqueueProjectSkill} from '../skill-generation/jobs';
import {adoptProjectSkill,publishProjectRules} from '../rules';

export async function startAutomation(pool:Pool,projectId:string,body:any){
 if(!body||!['horizontal','vertical'].includes(body.mode)||body.workflow_ids!==undefined&&(!Array.isArray(body.workflow_ids)||!body.workflow_ids.length||body.workflow_ids.length>100))throw new HTTPException(400,{message:'请选择横向或纵向模式，批次最多100题'});
 if(body.workflow_ids)body={...body,workflow_ids:[...new Set(body.workflow_ids.map((id:unknown)=>uuid(String(id))))]};
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  if(!(await db.query('SELECT id FROM ai_distill.projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[projectId])).rowCount)throw new HTTPException(404,{message:'项目不存在'});
  const rows=(await db.query('SELECT id,input_revision FROM ai_distill.workflows WHERE project_id=$1 AND deleted_at IS NULL AND ($2::uuid[] IS NULL OR id=ANY($2)) ORDER BY id FOR UPDATE',[projectId,body.workflow_ids??null])).rows;
  if(!rows.length||rows.length>100||body.workflow_ids&&new Set(body.workflow_ids).size!==rows.length)throw new HTTPException(400,{message:'批次须包含本项目1至100条有效题目'});
  const ids=rows.map(row=>row.id);
  if((await db.query("SELECT m.workflow_id FROM ai_distill.automation_members m JOIN ai_distill.automation_batches b ON b.id=m.batch_id WHERE m.workflow_id=ANY($1::uuid[]) AND b.status IN ('running','paused','blocked')",[ids])).rowCount)throw new HTTPException(409,{message:'题目已有自动批次，请恢复或取消原批次'});
  const id=crypto.randomUUID();
  await db.query('INSERT INTO ai_distill.automation_batches(id,project_id,mode) VALUES($1,$2,$3)',[id,projectId,body.mode]);
  for(const row of rows)await db.query("INSERT INTO ai_distill.automation_members(workflow_id,batch_id,input_revision) VALUES($1,$2,$3)",[row.id,id,row.input_revision]);
  await db.query('COMMIT');return {id};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
export async function listAutomation(pool:Pool,projectId:string){
 try{return (await pool.query(`SELECT b.*,COALESCE(jsonb_agg(jsonb_build_object('workflow_id',m.workflow_id,'status',m.status,'reason',m.reason)) FILTER(WHERE m.workflow_id IS NOT NULL),'[]') AS members FROM ai_distill.automation_batches b LEFT JOIN ai_distill.automation_members m ON m.batch_id=b.id WHERE b.project_id=$1 GROUP BY b.id ORDER BY b.created_at DESC LIMIT 30`,[projectId])).rows;}catch(error){throw error;}
}
export async function controlProjectExecution(pool:Pool,projectId:string,action:string){
 if(!['pause','resume','cancel'].includes(action))throw new HTTPException(400,{message:'控制动作无效'});
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const batches=(await db.query("SELECT id FROM ai_distill.automation_batches WHERE project_id=$1 AND status IN ('running','paused','blocked') ORDER BY id",[projectId])).rows;
  for(const batch of batches)await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[batch.id]);
  await db.query("SELECT pg_advisory_xact_lock(hashtext('ai_distill-dispatch'))");
  if(!(await db.query('UPDATE ai_distill.projects SET execution_paused=$2 WHERE id=$1 AND deleted_at IS NULL RETURNING id',[projectId,action!=='resume'])).rowCount)throw new HTTPException(404,{message:'项目不存在'});
  if(action==='cancel'){
   const ids=(await db.query('SELECT id FROM ai_distill.workflows WHERE project_id=$1 ORDER BY id FOR UPDATE',[projectId])).rows.map(row=>row.id);
   await db.query("UPDATE ai_distill.step_attempts SET status='skipped',error='项目执行已取消',finished_at=now() WHERE workflow_id=ANY($1::uuid[]) AND status IN ('waiting','running')",[ids]);
   await db.query("UPDATE ai_distill.steps SET status='failed',error='项目执行已取消',finished_at=now() WHERE workflow_id=ANY($1::uuid[]) AND status IN ('waiting','running') AND EXISTS(SELECT 1 FROM ai_distill.step_attempts a WHERE a.workflow_id=steps.workflow_id AND (a.ordinal=steps.ordinal OR (steps.ordinal=1 AND a.ordinal=2)) AND a.input_revision=(SELECT input_revision FROM ai_distill.workflows WHERE id=steps.workflow_id) AND a.error='项目执行已取消')",[ids]);
   await db.query("UPDATE ai_distill.project_skill_attempts SET status='failed',error='项目执行已取消',finished_at=now() WHERE project_id=$1 AND status IN ('waiting','running')",[projectId]);
   await db.query("UPDATE ai_distill.revision_rounds SET status='blocked' WHERE chain_id IN (SELECT id FROM ai_distill.revision_chains WHERE workflow_id=ANY($1::uuid[]) AND status IN ('waiting','running')) AND status IN ('waiting','running')",[ids]);
   await db.query("UPDATE ai_distill.revision_chains SET status='blocked',reason='project_cancelled',updated_at=now() WHERE workflow_id=ANY($1::uuid[]) AND status IN ('waiting','running')",[ids]);
   await db.query("UPDATE ai_distill.automation_batches SET status='cancelled',updated_at=now() WHERE project_id=$1 AND status IN ('running','paused','blocked')",[projectId]);
   await db.query("UPDATE ai_distill.automation_members SET status='cancelled',reason='project_cancelled',updated_at=now() WHERE workflow_id=ANY($1::uuid[]) AND status<>'completed'",[ids]);
  }
  await db.query('COMMIT');return {paused:action!=='resume'};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
export async function controlAutomation(pool:Pool,projectId:string,batchId:string,action:string){
 if(!['pause','resume','cancel'].includes(action))throw new HTTPException(400,{message:'控制动作无效'});
 const db=await pool.connect();
 try{
  await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[batchId]);await db.query("SELECT pg_advisory_xact_lock(hashtext('ai_distill-dispatch'))");
  const batch=(await db.query('SELECT * FROM ai_distill.automation_batches WHERE id=$1 AND project_id=$2 FOR UPDATE',[batchId,projectId])).rows[0];
  if(!batch)throw new HTTPException(404,{message:'批次不存在'});
  if(batch.status==='completed')throw new HTTPException(409,{message:'批次已完成'});
  if(batch.status==='cancelled'&&action!=='resume'){
   if(action==='cancel'){await db.query('COMMIT');return {status:'cancelled'};}
   throw new HTTPException(409,{message:'已取消批次不能暂停'});
  }
  const members=(await db.query('SELECT w.id FROM ai_distill.workflows w JOIN ai_distill.automation_members m ON m.workflow_id=w.id WHERE m.batch_id=$1 ORDER BY w.id FOR UPDATE OF w',[batchId])).rows;
  const ids=members.map(row=>row.id);
  if(action==='cancel'){
   await db.query("UPDATE ai_distill.step_attempts SET status='skipped',error='自动批次已取消',finished_at=now() WHERE workflow_id=ANY($1::uuid[]) AND status IN ('waiting','running')",[ids]);
   await db.query("UPDATE ai_distill.steps SET status='failed',error='自动批次已取消',finished_at=now() WHERE workflow_id=ANY($1::uuid[]) AND status IN ('waiting','running') AND EXISTS(SELECT 1 FROM ai_distill.step_attempts a WHERE a.workflow_id=steps.workflow_id AND (a.ordinal=steps.ordinal OR (steps.ordinal=1 AND a.ordinal=2)) AND a.input_revision=(SELECT input_revision FROM ai_distill.workflows WHERE id=steps.workflow_id) AND a.error='自动批次已取消')",[ids]);
   await db.query("UPDATE ai_distill.revision_rounds SET status='blocked' WHERE chain_id IN (SELECT id FROM ai_distill.revision_chains WHERE workflow_id=ANY($1::uuid[]) AND status IN ('waiting','running')) AND status IN ('waiting','running')",[ids]);
   await db.query("UPDATE ai_distill.revision_chains SET status='blocked',reason='batch_cancelled',updated_at=now() WHERE workflow_id=ANY($1::uuid[]) AND status IN ('waiting','running')",[ids]);
   await db.query("UPDATE ai_distill.automation_members SET status='cancelled',reason='batch_cancelled',updated_at=now() WHERE batch_id=$1 AND status<>'completed'",[batchId]);
  }
  if(action==='resume'){
   if((await db.query("SELECT m.workflow_id FROM ai_distill.automation_members m JOIN ai_distill.automation_batches b ON b.id=m.batch_id WHERE m.workflow_id=ANY($1::uuid[]) AND m.batch_id<>$2 AND (m.status IN ('running','blocked') OR b.created_at>$3)",[ids,batchId,batch.created_at])).rowCount)throw new HTTPException(409,{message:'题目已加入另一批次，请使用最新批次恢复'});
   await db.query("UPDATE ai_distill.automation_members m SET status='running',reason=NULL,input_revision=w.input_revision,updated_at=now() FROM ai_distill.workflows w WHERE m.workflow_id=w.id AND m.batch_id=$1 AND m.status<>'completed'",[batchId]);
   // Explicit resume authorizes retry of interrupted/failed work; successful work is preserved.
   await db.query("UPDATE ai_distill.steps SET status='waiting',error=NULL WHERE workflow_id=ANY($1::uuid[]) AND status='failed' AND NOT EXISTS(SELECT 1 FROM ai_distill.revision_chains r WHERE r.workflow_id=steps.workflow_id AND r.status IN ('waiting','running','blocked','isolated') AND r.id=(SELECT latest.id FROM ai_distill.revision_chains latest JOIN ai_distill.workflows w ON w.id=latest.workflow_id WHERE latest.workflow_id=steps.workflow_id AND latest.input_revision=w.input_revision ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1))",[ids]);
  }
  await db.query('UPDATE ai_distill.automation_batches SET status=$2,updated_at=now() WHERE id=$1',[batchId,action==='pause'?'paused':action==='cancel'?'cancelled':'running']);
  await db.query('COMMIT');
  if(action==='resume'){
   const chains=(await pool.query("SELECT id,workflow_id FROM ai_distill.revision_chains WHERE workflow_id=ANY($1::uuid[]) AND status='blocked' AND reason IN ('batch_cancelled','project_cancelled')",[ids])).rows;
   for(const chain of chains)try{await resumeRevision(pool,chain.workflow_id,chain.id);}catch(error){await pool.query("UPDATE ai_distill.automation_members SET status='blocked',reason=$2 WHERE workflow_id=$1 AND batch_id=$3",[chain.workflow_id,error instanceof HTTPException?error.message:'返修恢复失败，请核对预算',batchId]);}
  }
  return {status:action==='pause'?'paused':action==='cancel'?'cancelled':'running'};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
async function dispatch(pool:Pool,root:string,id:string,ordinal:number){
 try{switch(ordinal){
  case 1:return await enqueueIngestion(pool,id);
  case 2:return await enqueueExtraction(pool,id);
  case 9:return await enqueueRedaction(pool,id);
  case 3:return await loadWorkflowRules(pool,id);
  case 4:return await enqueueAuthoring(pool,id);
  case 5:return await enqueueAnswer(pool,id,root);
  case 6:return await enqueueScore(pool,id);
  case 7:return await runAcceptance(pool,id);
  case 8:return await publishWorkflow(pool,id,root);
  default:throw new HTTPException(409,{message:'当前步骤执行器尚未接入自动调度'});
 }}catch(error){throw error;}
}
async function ensureRules(pool:Pool,projectId:string,root:string){
 try{const published=(await pool.query("SELECT id FROM ai_distill.rule_versions WHERE project_id=$1 AND status='published' ORDER BY version DESC LIMIT 1",[projectId])).rows[0];
 if(published)return;
 const task=(await pool.query('SELECT * FROM ai_distill.project_skill_attempts WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1',[projectId])).rows[0];
 if(task?.status==='succeeded'){
  const draft=await adoptProjectSkill(pool,projectId,task.id,root);
  await publishProjectRules(pool,projectId,draft.manifest.source_digest);return;
 }
 if(task?.status==='waiting'||task?.status==='running')throw new HTTPException(425,{message:'等待项目skill生成'});
 if(task?.status==='failed')throw new HTTPException(409,{message:'项目skill生成失败，请检查后重试'});
 const config=(await pool.query('SELECT config FROM ai_distill.project_step_configs WHERE project_id=$1 AND ordinal=3',[projectId])).rows[0]?.config;
 if(!config)throw new HTTPException(409,{message:'缺少skill，请先保存规则生成模型设置'});
 await enqueueProjectSkill(pool,projectId,config);throw new HTTPException(425,{message:'等待项目skill生成'});
 }catch(error){throw error;}
}
export async function runAutomationTick(pool:Pool,root:string){
 try{const batches=(await pool.query("SELECT b.* FROM ai_distill.automation_batches b JOIN ai_distill.projects p ON p.id=b.project_id WHERE b.status='running' AND NOT p.execution_paused AND p.deleted_at IS NULL ORDER BY b.created_at LIMIT 100")).rows;
 for(const batch of batches){
  const lock=await pool.connect();let acquired=false;
  try{
   acquired=(await lock.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',[batch.id])).rows[0]?.acquired;
   if(!acquired)continue;
   if(!(await lock.query("SELECT id FROM ai_distill.automation_batches WHERE id=$1 AND status='running'",[batch.id])).rowCount)continue;
   const rows=(await pool.query(`SELECT m.*,w.input_revision AS current_revision,w.deleted_at FROM ai_distill.automation_members m JOIN ai_distill.workflows w ON w.id=m.workflow_id WHERE m.batch_id=$1`,[batch.id])).rows;
   const plans:{id:string;plan:WorkflowPlan}[]=[];
   for(const member of rows){
    if(member.status!=='running')continue;
    if(member.input_revision!==member.current_revision||member.deleted_at){await pool.query("UPDATE ai_distill.automation_members SET status='blocked',reason='input_changed',updated_at=now() WHERE workflow_id=$1 AND batch_id=$2",[member.workflow_id,batch.id]);continue;}
    const steps=(await pool.query('SELECT ordinal,display_position,enabled,status FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal<>2',[member.workflow_id])).rows;
    const active=(await pool.query("SELECT DISTINCT ordinal FROM ai_distill.step_attempts WHERE workflow_id=$1 AND input_revision=$2 AND status IN ('waiting','running')",[member.workflow_id,member.input_revision])).rows.map(row=>row.ordinal);
    const hasPdf=(await pool.query("SELECT EXISTS(SELECT 1 FROM ai_distill.materials WHERE workflow_id=$1 AND input_revision=$2 AND lower(original_name) LIKE '%.pdf') AS value",[member.workflow_id,member.input_revision])).rows[0]?.value;
    if(hasPdf){const ingest=steps.find(step=>step.ordinal===1),extraction=(await pool.query('SELECT status FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=2',[member.workflow_id])).rows[0];if(ingest&&extraction)ingest.status=extraction.status;if(active.includes(2))active.push(1);}
    const revision=(await pool.query("SELECT status,reason FROM ai_distill.revision_chains WHERE workflow_id=$1 AND input_revision=$2 ORDER BY created_at DESC,id DESC LIMIT 1",[member.workflow_id,member.input_revision])).rows[0];
    if(revision?.status==='waiting'||revision?.status==='running'){plans.push({id:member.workflow_id,plan:{kind:'wait' as const,position:[...steps].sort((a,b)=>a.display_position-b.display_position).find(step=>step.status!=='succeeded'&&step.status!=='skipped'&&step.enabled)?.display_position??1}});continue;}
    if(revision?.status==='blocked'||revision?.status==='isolated'){await pool.query("UPDATE ai_distill.automation_members SET status='blocked',reason=$2,updated_at=now() WHERE workflow_id=$1 AND batch_id=$3",[member.workflow_id,revision.reason??'返修需处理',batch.id]);continue;}
    const plan=planWorkflow(steps,active);plans.push({id:member.workflow_id,plan});
    if(plan.kind==='blocked'&&[4,7].includes(plan.ordinal)){
     const failed=(await pool.query('SELECT id,result FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=$2 AND input_revision=$3 ORDER BY attempt DESC LIMIT 1',[member.workflow_id,plan.ordinal,member.input_revision])).rows[0];
     if(failed?.result?.quality_check?.passed===false||failed?.result?.decision==='repair'){
      try{const chain=await startRevision(pool,member.workflow_id,failed.id);if(chain.status==='waiting'||chain.status==='running'){plans[plans.length-1]={id:member.workflow_id,plan:{kind:'wait',position:plan.position}};continue;}await pool.query("UPDATE ai_distill.automation_members SET status='blocked',reason=$2,updated_at=now() WHERE workflow_id=$1 AND batch_id=$3",[member.workflow_id,chain.reason??'返修需处理',batch.id]);continue;}
      catch(error){await pool.query("UPDATE ai_distill.automation_members SET status='blocked',reason=$2,updated_at=now() WHERE workflow_id=$1 AND batch_id=$3",[member.workflow_id,error instanceof HTTPException?error.message:'返修启动失败，请核对后恢复',batch.id]);continue;}
     }
    }
    if(plan.kind==='done'||plan.kind==='blocked')await pool.query('UPDATE ai_distill.automation_members SET status=$2,reason=$3,updated_at=now() WHERE workflow_id=$1 AND batch_id=$4',[member.workflow_id,plan.kind==='done'?'completed':'blocked',plan.kind==='blocked'?plan.reason:null,batch.id]);
   }
   for(const id of planBatch(batch.mode,plans)){
    const plan=plans.find(member=>member.id===id)!.plan;if(plan.kind!=='dispatch')continue;
    try{
     if(plan.ordinal===3)await ensureRules(pool,batch.project_id,root);
     const task=await dispatch(pool,root,id,plan.ordinal);
     if('decision' in task&&task.decision==='waiting')await pool.query("UPDATE ai_distill.automation_members SET status='blocked',reason='等待有效作答或评分，请检查后恢复',updated_at=now() WHERE workflow_id=$1 AND batch_id=$2",[id,batch.id]);
    }
    catch(error){if(error instanceof HTTPException&&error.status===425)continue;await pool.query("UPDATE ai_distill.automation_members SET status='blocked',reason=$2,updated_at=now() WHERE workflow_id=$1 AND batch_id=$3",[id,error instanceof HTTPException?error.message:'调度失败，请检查后恢复',batch.id]);}
   }
   await pool.query(`UPDATE ai_distill.automation_batches b SET status=CASE WHEN EXISTS(SELECT 1 FROM ai_distill.automation_members WHERE batch_id=b.id AND status='blocked') THEN 'blocked' ELSE 'completed' END,updated_at=now() WHERE b.id=$1 AND b.status='running' AND NOT EXISTS(SELECT 1 FROM ai_distill.automation_members WHERE batch_id=b.id AND status='running')`,[batch.id]);
  }finally{try{if(acquired)await lock.query('SELECT pg_advisory_unlock(hashtext($1))',[batch.id]);}finally{lock.release();}}
 }
 return batches.length>0;
 }catch(error){throw error;}
}
