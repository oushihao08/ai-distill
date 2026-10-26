/**
 * 职责：按旧材料workflow_id持久编排服务器入库、PDF/DOCX提取和人工声明直通；不是全局library_jobs，材料worker逐次推进。
 * 关键入口：createRemoteMaterialOperation、readRemoteMaterialOperation、runNextRemoteMaterialOperation。
 * 使用场景：本机 CLI 经受限 API 发起一次组合操作，即使客户端断线仍由服务器继续处理。
 */
import {releaseRolledBackRegistrations,forgetLocalRegistrations,registerLocalJob,localClaimSql,localQueueEnabled} from './execution-queue/runtime';
import {createHash,randomUUID} from 'node:crypto';
import {HTTPException} from 'hono/http-exception';
import type {Pool} from 'pg';
import {enqueueIngestion} from './intake-jobs';
import {enqueueRedaction} from './materials/redaction-jobs';
import {REDACTION_PROTOCOL_VERSION} from './materials/redaction';
import {scanQuestionFolder,validateFolder} from './project-folders';

export type RemoteMaterialMode='intake'|'redact'|'intake-redact';
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const digestSourceManifest=(items:unknown)=>digest((Array.isArray(items)?items:[]).map((item:any)=>[item.name,item.path,item.size,item.sha256]));
export async function currentMaterialDigest(pool:Pool,workflowId:string){
 const rows=(await pool.query('SELECT id,sha256,storage_path,redaction_mode FROM ai_distill.materials WHERE workflow_id=$1 AND deleted_at IS NULL ORDER BY id',[workflowId])).rows;
 return digest(rows.map((row:any)=>[row.id,row.sha256,row.storage_path,...(row.redaction_mode==='declared_redacted'?['declared_redacted']:[])]));
}
async function currentRedactionConfig(pool:Pool,workflowId:string){
 const projectId=(await pool.query('SELECT project_id FROM ai_distill.workflows WHERE id=$1',[workflowId])).rows[0]?.project_id;
 if(!projectId)throw new HTTPException(404,{message:'题目不存在'});
 const modes=(await pool.query("SELECT count(*)::int AS total,count(*) FILTER (WHERE redaction_mode='declared_redacted')::int AS declared FROM ai_distill.materials WHERE workflow_id=$1 AND deleted_at IS NULL",[workflowId])).rows[0];
 if(modes?.total>0&&modes.total===modes.declared)return{provider:'manual',digest:digest({provider:'manual',text_layout:REDACTION_PROTOCOL_VERSION})};
 throw new HTTPException(409,{message:'字段映射脱敏已删除，远程旧流程仅支持人工已脱敏声明；其他材料请使用共享材料库'});
}

export async function createRemoteMaterialOperation(pool:Pool,workflowId:string,mode:RemoteMaterialMode,requestKey:string){
 if(!['intake','redact','intake-redact'].includes(mode))throw new HTTPException(400,{message:'材料处理模式无效'});
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestKey))throw new HTTPException(400,{message:'请求标识须为 UUID'});
 const workflow=(await pool.query('SELECT w.id,w.source_key,w.source_manifest,p.material_root FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL WHERE w.id=$1 AND w.deleted_at IS NULL',[workflowId])).rows[0];
 if(!workflow)throw new HTTPException(404,{message:'题目不存在'});
 const existing=(await pool.query('SELECT * FROM ai_distill.remote_material_operations WHERE workflow_id=$1 AND request_key=$2',[workflowId,requestKey])).rows[0];
 if(existing){if(existing.mode!==mode)throw new HTTPException(409,{message:'请求标识已用于其他处理模式'});return existing;}
 if(mode!=='redact'){
  if(!workflow.source_key)throw new HTTPException(409,{message:'题目没有材料目录'});
  const actual=await scanQuestionFolder(await validateFolder(workflow.material_root),workflow.source_key);
  if(!actual.files.length)throw new HTTPException(409,{message:'服务器没有同步的题目附件'});
  const listed=Array.isArray(workflow.source_manifest)?workflow.source_manifest:[];
  const manifest=(items:any[])=>items.map(item=>[item.name,item.path,item.size,item.sha256]);
  if(JSON.stringify(manifest(actual.files))!==JSON.stringify(manifest(listed)))throw new HTTPException(409,{message:'服务器来源附件与数据库清单不一致，请先同步正确版本'});
 }
 const redactionConfig=mode==='intake'?null:await currentRedactionConfig(pool,workflowId);
 if(redactionConfig&&redactionConfig.provider!=='manual')throw new HTTPException(409,{message:'服务器旧流程仅支持人工已脱敏材料归档'});
 if(mode==='redact'){
  const ready=(await pool.query('SELECT status FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal=1',[workflowId])).rows[0]?.status;
  if(ready!=='succeeded')throw new HTTPException(409,{message:'材料尚未完成入库，不能单独脱敏'});
 }
 const sourceDigest=digestSourceManifest(workflow.source_manifest);
 const stage=mode==='redact'?'redact':'intake';
 const initialMaterialDigest=mode==='redact'?await currentMaterialDigest(pool,workflowId):null;
 let created:any;const registration=await pool.connect();
 try{
  await registration.query('BEGIN');
  created=(await registration.query(`INSERT INTO ai_distill.remote_material_operations(id,workflow_id,mode,request_key,source_digest,stage,material_digest,redaction_config_digest)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workflow_id,request_key) DO NOTHING RETURNING *`,[randomUUID(),workflowId,mode,requestKey,sourceDigest,stage,initialMaterialDigest,redactionConfig?.digest??null])).rows[0];
  if(created)await registerLocalJob(registration,created.id,'remote','remote','remote');
  await registration.query('COMMIT');forgetLocalRegistrations(registration);
 }catch(error){await registration.query('ROLLBACK');await releaseRolledBackRegistrations(registration);if((error as {code?:string}).code==='23505')throw new HTTPException(409,{message:'这道题已有进行中的远程材料操作'});throw error;}finally{registration.release();}
 if(created)return created;
 const concurrent=(await pool.query('SELECT * FROM ai_distill.remote_material_operations WHERE workflow_id=$1 AND request_key=$2',[workflowId,requestKey])).rows[0];
 if(concurrent?.mode!==mode||concurrent?.source_digest!==sourceDigest)throw new HTTPException(409,{message:'请求标识对应的材料版本已变化'});
 return concurrent;
}

export async function readRemoteMaterialOperation(pool:Pool,id:string){
 const row=(await pool.query('SELECT id,workflow_id,mode,status,stage,intake_attempt_id,extraction_attempt_id,redaction_attempt_id,error_code,source_digest,material_digest,redaction_config_digest,created_at,updated_at FROM ai_distill.remote_material_operations WHERE id=$1',[id])).rows[0];
 if(!row)throw new HTTPException(404,{message:'远程材料操作不存在'});
 return row;
}

async function update(pool:Pool,id:string,claimToken:string,values:{status?:string;stage?:string;intake_attempt_id?:string;extraction_attempt_id?:string;redaction_attempt_id?:string;error_code?:string;material_digest?:string;redaction_config_digest?:string}){
 await pool.query(`UPDATE ai_distill.remote_material_operations SET
  status=COALESCE($2,status),stage=COALESCE($3,stage),intake_attempt_id=COALESCE($4,intake_attempt_id),
  extraction_attempt_id=COALESCE($5,extraction_attempt_id),redaction_attempt_id=COALESCE($6,redaction_attempt_id),
  error_code=COALESCE($7,error_code),material_digest=COALESCE($8,material_digest),redaction_config_digest=COALESCE($9,redaction_config_digest),updated_at=now() WHERE id=$1 AND claim_token=$10`,[id,values.status??null,values.stage??null,values.intake_attempt_id??null,values.extraction_attempt_id??null,values.redaction_attempt_id??null,values.error_code??null,values.material_digest??null,values.redaction_config_digest??null,claimToken]);
}

/** 一次只推进一个检查点。每次派发均使用既有队列的复用规则，避免 worker 重启后重做。 */
export async function runNextRemoteMaterialOperation(pool:Pool){
 const claimToken=randomUUID();
 const op=(await pool.query(`UPDATE ai_distill.remote_material_operations SET status='running',claim_token=$1,updated_at=now()
  WHERE id=(SELECT id FROM ai_distill.remote_material_operations WHERE (status='waiting' OR (status='running' AND (updated_at<now()-interval '30 seconds' OR ${localQueueEnabled()?'TRUE':'FALSE'}))) ${localClaimSql('remote_material_operations')} ORDER BY updated_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
  RETURNING *`,[claimToken])).rows[0];
 if(!op)return false;
 const advance=(values:Parameters<typeof update>[3])=>update(pool,op.id,claimToken,values);
 try{
  const workflow=(await pool.query('SELECT w.source_manifest,w.source_key,p.material_root FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id AND p.deleted_at IS NULL WHERE w.id=$1 AND w.deleted_at IS NULL',[op.workflow_id])).rows[0];
  if(!workflow||digestSourceManifest(workflow.source_manifest)!==op.source_digest){await advance({status:'failed',error_code:'source_changed'});return true;}
  const steps=(await pool.query('SELECT ordinal,status,error FROM ai_distill.steps WHERE workflow_id=$1 AND ordinal IN (1,2,9)',[op.workflow_id])).rows;
  const byStep=new Map<number,{status:string;error:string|null}>(steps.map((step:any)=>[step.ordinal,step]));
  const attempts=(await pool.query('SELECT id,ordinal,status,error,execution_target FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal IN (1,2,9) ORDER BY attempt DESC',[op.workflow_id])).rows;
  const byOrdinal=(ordinal:number)=>attempts.find((attempt:any)=>attempt.ordinal===ordinal&&attempt.execution_target==='server');
  const latest=(ordinal:number)=>attempts.find((attempt:any)=>attempt.ordinal===ordinal);
  if(op.stage==='intake'||op.stage==='extract'){
   const state=byStep.get(1)?.status;
   if(state==='succeeded'){
    if(latest(1)?.execution_target!=='server'||latest(1)?.status!=='succeeded'){
     await advance({status:'failed',error_code:'intake_completed_elsewhere'});return true;
    }
    const nextIsRedact=op.mode!=='intake';
    const redactionConfig=nextIsRedact?await currentRedactionConfig(pool,op.workflow_id):null;
    if(redactionConfig&&(redactionConfig.provider!=='manual'||redactionConfig.digest!==op.redaction_config_digest)){await advance({status:'failed',error_code:'redaction_config_changed'});return true;}
    await advance({stage:nextIsRedact?'redact':'complete',status:nextIsRedact?'running':'succeeded',extraction_attempt_id:byOrdinal(2)?.id,material_digest:await currentMaterialDigest(pool,op.workflow_id)});return true;
   }
   const intake=attempts.find((attempt:any)=>attempt.id===op.intake_attempt_id);
   const extraction=attempts.find((attempt:any)=>attempt.id===op.extraction_attempt_id);
   if(!op.intake_attempt_id&&!op.extraction_attempt_id){
    const task=await enqueueIngestion(pool,op.workflow_id,'server',op.source_digest);
    const ordinal=task.id?(await pool.query('SELECT ordinal FROM ai_distill.step_attempts WHERE id=$1',[task.id])).rows[0]?.ordinal:null;
    await advance({stage:ordinal===2?'extract':'intake',...(ordinal===2?{extraction_attempt_id:task.id}:{intake_attempt_id:task.id||undefined})});return true;
   }
   if(state==='failed'&&(intake?.status==='failed'||extraction?.status==='failed')){await advance({status:'failed',error_code:'intake_failed'});return true;}
   if(intake?.status==='succeeded'&&!extraction){
    const hasPdf=(await pool.query("SELECT EXISTS(SELECT 1 FROM ai_distill.materials WHERE workflow_id=$1 AND deleted_at IS NULL AND (lower(original_name) LIKE '%.pdf' OR lower(original_name) LIKE '%.docx')) AS value",[op.workflow_id])).rows[0]?.value;
    if(hasPdf){
     const task=await enqueueIngestion(pool,op.workflow_id,'server');
     await advance({stage:'extract',extraction_attempt_id:task.id||undefined});return true;
    }
   }
   if(intake?.status==='failed'||extraction?.status==='failed'){await advance({status:'failed',error_code:'intake_failed'});return true;}
   await advance({stage:extraction?'extract':'intake',extraction_attempt_id:extraction?.id});return true;
  }
  if(op.stage==='redact'){
   const redactionConfig=await currentRedactionConfig(pool,op.workflow_id);
   if(redactionConfig.provider!=='manual'||redactionConfig.digest!==op.redaction_config_digest){await advance({status:'failed',error_code:'redaction_config_changed'});return true;}
   if(await currentMaterialDigest(pool,op.workflow_id)!==op.material_digest){await advance({status:'failed',error_code:'materials_changed'});return true;}
   if(byStep.get(1)?.status!=='succeeded'){await advance({status:'failed',error_code:'intake_not_ready'});return true;}
   if(byStep.get(9)?.status==='succeeded'&&latest(9)?.execution_target==='server'&&latest(9)?.status==='succeeded'){await advance({status:'succeeded',stage:'complete',redaction_attempt_id:latest(9).id,material_digest:await currentMaterialDigest(pool,op.workflow_id)});return true;}
   if(byStep.get(9)?.status==='succeeded'){
    await advance({status:'failed',error_code:'redaction_completed_elsewhere'});return true;
   }
   const redaction=attempts.find((attempt:any)=>attempt.id===op.redaction_attempt_id);
   if(redaction?.status==='failed'){await advance({status:'failed',error_code:'redaction_failed'});return true;}
   if(!redaction||redaction.status==='succeeded'){
    const task=await enqueueRedaction(pool,op.workflow_id,'server');
    await advance({redaction_attempt_id:task.id});return true;
   }
   await advance({redaction_attempt_id:redaction.id});return true;
  }
  await advance({status:'failed',error_code:'invalid_stage'});
  return true;
 }catch(error){
  if(error instanceof HTTPException){await advance({status:'failed',error_code:'operation_not_ready'});return true;}
  throw error;
 }
}
