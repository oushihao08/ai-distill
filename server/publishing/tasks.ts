/**
 * 职责：第八步持久派发、领取和失败结算；HTTP只返回任务ID，worker生成所有产物后才提交成功。
 * 入口：enqueuePublication()供HTTP；runNextPublication()供local/legacy worker。
 * 边界：冻结达标/项目/脚本身份，复用同输入活动任务；未知调用不重放，不自动派发其他步骤。
 */
import type {Pool} from 'pg';
import {HTTPException} from 'hono/http-exception';
import {fileURLToPath} from 'node:url';
import {canonicalJson} from '../../shared/workflow-config';
import {localClaimSql,localWaitingSql,registerLocalJob,withLocalQueueRoot,deferLocalPublication,readStepFailure,saveStepFailure,RecordedStepFailure} from '../execution-queue/runtime';
import {exportCurrentMaterialDocx} from '../materials/redacted-docx-export';
import {writeArchivedWorkflowWorkbook} from '../reporting/archive-workbook';
import {publishWorkflow,type PublicationBinding} from './jobs';
import {resolveProjectDelivery} from './project-delivery';
import {readProjectAgentDefaults} from '../agent/config';
import {watchTaskCancellation} from '../task-signal';
import {logEvent,classifyLogError,withLogContext} from '../logging';

type Identity={task_id:string;org:string};
const assetRoot=fileURLToPath(new URL('../../assets/out/',import.meta.url));
async function publicationBinding(db:Pick<Pool,'query'>,workflowId:string):Promise<PublicationBinding>{
 const workflow=(await db.query(`SELECT w.project_id,w.title,w.source_key,p.parent_name,p.phase_name
  FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL
  WHERE w.id=$1 AND w.deleted_at IS NULL FOR UPDATE OF w`,[workflowId])).rows[0];
 if(!workflow)throw new HTTPException(404,{message:'工作流不存在'});
 const accepted=(await db.query("SELECT id,input,result FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=7 AND status='succeeded' ORDER BY attempt DESC LIMIT 1",[workflowId])).rows[0];
 const current=(await db.query('SELECT status,result FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=7',[workflowId])).rows[0];
 if(!accepted||current?.status!=='succeeded'||current.result?.decision!=='accepted'||accepted.result?.decision!=='accepted'||typeof accepted.input?.source_digest!=='string')throw new HTTPException(409,{message:'当前版本尚未达标'});
 const delivery=await resolveProjectDelivery(workflow.parent_name);
 return{project_id:workflow.project_id,title:workflow.title,parent_name:workflow.parent_name??null,phase_name:workflow.phase_name??null,source_key:workflow.source_key??null,acceptance_attempt_id:accepted.id,source_digest:accepted.input.source_digest,delivery_digest:delivery.digest};
}

export async function enqueuePublication(pool:Pool,workflowId:string,root:string,identity?:Identity,exportsRoot=assetRoot){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  if(identity&&(!/^LAW-\d{3,}$/.test(identity.task_id)||!/^[a-z0-9][a-z0-9-]{1,31}$/.test(identity.org)))throw new HTTPException(400,{message:'可选交付身份格式无效'});
  const binding=await publicationBinding(db,workflowId);
  const workContract=binding.parent_name==='Work法律全场景'
   ?(await db.query("SELECT result->>'content_contract' AS content_contract FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=4",[workflowId])).rows[0]?.content_contract:null;
  const legacyAgentConfig=binding.parent_name==='Work法律全场景'&&workContract!=='work_legal_v1'?await readProjectAgentDefaults(db,binding.project_id):null;
  const input={binding,legacy_agent_config:legacyAgentConfig,delivery_identity:identity??null,exports_root:exportsRoot};
  const previous=(await db.query("SELECT id,input FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=8 AND status IN ('waiting','running') ORDER BY attempt DESC LIMIT 1",[workflowId])).rows[0];
  if(previous){
   if(canonicalJson(previous.input)!==canonicalJson(input))throw new HTTPException(409,{message:'此题已有其他输入的交付任务，请先核对原任务'});
   await db.query('COMMIT');return{id:String(previous.id),reused:true};
  }
  const id=crypto.randomUUID();
  await db.query("INSERT INTO ai_distill.step_attempts(id,workflow_id,ordinal,attempt,status,input,config) SELECT $2,$1::uuid,8,COALESCE(max(attempt),0)+1,'waiting',$3,'{}'::jsonb FROM ai_distill.step_attempts WHERE workflow_id=$1::uuid AND ordinal=8",[workflowId,id,JSON.stringify(input)]);
  await withLocalQueueRoot(root,()=>registerLocalJob(db,id,'step','internal','publish'));
  await db.query("UPDATE ai_distill.steps SET implemented=true,status='waiting',result=NULL,error=NULL,started_at=NULL,finished_at=NULL WHERE workflow_id=$1 AND ordinal=8",[workflowId]);
  await db.query('COMMIT');return{id,reused:false};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}

interface Dependencies {publish?:typeof publishWorkflow;docx?:typeof exportCurrentMaterialDocx;workbook?:typeof writeArchivedWorkflowWorkbook}
export async function runNextPublication(pool:Pool,root:string,signal:AbortSignal,workflowIds?:string[],dependencies:Dependencies={}){
 if(signal.aborted)return false;
 const failure=readStepFailure();
 const db=await pool.connect();let job:any;
 try{
  await db.query('BEGIN');
  // legacy兼容只结算失联任务，不重新执行；local失租由本机检查点恢复。
  const stale=(await db.query(`UPDATE ai_distill.step_attempts a SET status='failed',error='交付执行进程失联，请核对产物后重新派发',finished_at=now()
   WHERE a.ordinal=8 AND a.status='running' AND COALESCE(a.heartbeat_at,a.started_at)<now()-interval '5 minutes' ${localClaimSql('a',true)}
   AND ($1::uuid[] IS NULL OR a.workflow_id=ANY($1)) RETURNING a.id,a.workflow_id`,[workflowIds??null])).rows;
  for(const item of stale)await db.query("UPDATE ai_distill.steps SET status='failed',error='交付执行进程失联',finished_at=now() WHERE workflow_id=$1 AND ordinal=8 AND status='running' AND $2=(SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=8 ORDER BY attempt DESC LIMIT 1)",[item.workflow_id,item.id]);
  job=(await db.query(`SELECT a.* FROM ai_distill.step_attempts a JOIN ai_distill.workflows w ON w.id=a.workflow_id AND w.deleted_at IS NULL
   JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL
   WHERE a.ordinal=8 AND ${localWaitingSql('a')} ${localClaimSql('a')} AND ($1::uuid[] IS NULL OR a.workflow_id=ANY($1))
   ORDER BY a.started_at,a.id FOR UPDATE OF a SKIP LOCKED LIMIT 1`,[workflowIds??null])).rows[0];
  if(!job){await db.query('COMMIT');return false;}
  if(!failure){
   await db.query("UPDATE ai_distill.step_attempts SET status='running',started_at=COALESCE(started_at,now()),heartbeat_at=now() WHERE id=$1",[job.id]);
   await db.query("UPDATE ai_distill.steps SET status='running',started_at=COALESCE(started_at,now()),error=NULL WHERE workflow_id=$1 AND ordinal=8",[job.workflow_id]);
  }
  await db.query('COMMIT');
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 const cancellation=watchTaskCancellation(pool,job.id,signal);
 const taskSignal=cancellation.signal;
 return withLogContext({component:'publishing',workflow_id:job.workflow_id,attempt_id:job.id,ordinal:8},async()=>{
  let beating=false;
  const heartbeat=setInterval(()=>{
   if(beating)return;beating=true;
   void pool.query("UPDATE ai_distill.step_attempts SET heartbeat_at=now() WHERE id=$1 AND status='running'",[job.id])
    .catch(error=>logEvent('heartbeat.write_failed',{level:'error',...classifyLogError(error)})).finally(()=>{beating=false;});
  },15000);heartbeat.unref();
  try{
   if(failure)throw new RecordedStepFailure(failure);
   taskSignal.throwIfAborted();
   const expected=job.input?.binding as PublicationBinding|undefined;
   if(!expected)throw new Error('交付任务缺少冻结来源');
   await (dependencies.publish??publishWorkflow)(pool,job.workflow_id,root,job.input.delivery_identity??undefined,{
    attemptId:job.id,expected,signal:taskSignal,exportsRoot:job.input.exports_root,expectedLegacyAgentConfig:job.input.legacy_agent_config??undefined,
    prepareArtifacts:async()=>{
     taskSignal.throwIfAborted();
     const docx=await (dependencies.docx??exportCurrentMaterialDocx)(pool,job.workflow_id,root,job.input.exports_root);
     const workbook=await (dependencies.workbook??writeArchivedWorkflowWorkbook)(pool,job.workflow_id,job.input.exports_root,true);
     return{material_docx:{archive_path:docx.archive_path,artifact_count:docx.artifacts.length},archive_workbook:{archive_path:workbook.archive_path,sha256:workbook.sha256,filename:workbook.filename}};
    },
   });
  }catch(error){
   deferLocalPublication(error);
   const diagnosticId=(error as {diagnostic_id?:unknown})?.diagnostic_id;
   const diagnostic=typeof diagnosticId==='string'&&/^[0-9a-f-]{36}$/i.test(diagnosticId)?{diagnostic_id:diagnosticId}:{};
   const terminal=saveStepFailure(error instanceof RecordedStepFailure?error.failure:{status:'failed',message:'交付未完成，请按任务ID查看记录后恢复',result:{...classifyLogError(error),...diagnostic}});
   const settle=await pool.connect();
   try{
    await settle.query('BEGIN');
    await settle.query("UPDATE ai_distill.step_attempts SET status=$2,error=$3,result=$4,finished_at=now() WHERE id=$1 AND status IN ('waiting','running')",[job.id,terminal.status,terminal.message,JSON.stringify(terminal.result)]);
    await settle.query("UPDATE ai_distill.steps SET status='failed',error=$3,finished_at=now() WHERE workflow_id=$1 AND ordinal=8 AND status IN ('waiting','running') AND $2=(SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=8 ORDER BY attempt DESC LIMIT 1)",[job.workflow_id,job.id,terminal.message]);
    await settle.query('COMMIT');
   }catch(settleError){await settle.query('ROLLBACK');throw settleError;}finally{settle.release();}
   logEvent('attempt.failed',{level:'error',...classifyLogError(error)});
  }finally{clearInterval(heartbeat);cancellation.dispose();}
  return true;
 });
}
