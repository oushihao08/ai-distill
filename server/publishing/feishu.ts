/**
 * 职责：豆包已达标且已归档题目的飞书交付；读取期次默认或显式目标，上传当前冻结材料DOCX并更新同一目标表内的题目记录。
 * 入口：syncArchivedWorkflowToFeishu()供归档worker与显式补传HTTP入口；失败独立记录，不回滚归档。
 * 边界：只启用豆包主项目；凭证仅从服务端环境读取，远端响应正文不进入公开错误或日志。
 */
import type {Pool} from 'pg';
import {createHash} from 'node:crypto';
import {HTTPException} from 'hono/http-exception';
import {exportCurrentMaterialDocx,readCurrentMaterialDocx} from '../materials/redacted-docx-export';
import {logEvent} from '../logging';
import {canonicalJson} from '../../shared/workflow-config';
import {feishuTextFields,compareFeishuText,VerificationError} from './feishu-verification';

import {feishuClient,SyncError,ensureFeishuSchema,createFeishuTable,removeEmptyFeishuRows} from './feishu-api';
import {readFeishuDeliveryConfig,validateFeishuTarget,type FeishuTarget} from './feishu-targets';

/** 可见题目ID与隐藏系统ID均关联workflow UUID；普通文本字段不锁定或冻结。 */
export async function syncArchivedWorkflowToFeishu(pool:Pool,workflowId:string,storageRoot:string,assetRoot:string,targetOverride?:FeishuTarget,allowRecreateDeleted=false){
 workflowId=workflowId.toLowerCase();
 const context=(await pool.query(`SELECT w.project_id,p.project_group_id,p.phase_name FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id WHERE w.id=$1 AND w.deleted_at IS NULL AND p.deleted_at IS NULL`,[workflowId])).rows[0];
 if(!context)return{status:'not_applicable'};
 const settings=await readFeishuDeliveryConfig(pool,String(context.project_id));
 if(!settings)return{status:'not_applicable'};
 const target=targetOverride?validateFeishuTarget(targetOverride):settings.default_target;
 const base=target.base_token;
 let tableId='table_id' in target?target.table_id:undefined;
 let db=await pool.connect(),connectionHeld=true;let transaction=false,archiveId:string|undefined,archiveAttemptId:string|undefined;
 let verification:any={status:'incomplete',checked_at:new Date().toISOString()};
 try{
  const snapshot=async()=> (await db.query(`SELECT q.result AS question,a.result AS acceptance,r.result AS archive,(SELECT input FROM ai_distill.step_attempts WHERE workflow_id=q.workflow_id AND ordinal=4 AND status='succeeded' AND result->>'question_version'=q.result->>'question_version' AND result->>'rubric_version'=q.result->>'rubric_version' ORDER BY attempt DESC LIMIT 1) AS authoring_input,(SELECT id FROM ai_distill.step_attempts WHERE workflow_id=q.workflow_id AND ordinal=8 AND status='succeeded' ORDER BY attempt DESC LIMIT 1) AS archive_attempt_id
   FROM ai_distill.steps q JOIN ai_distill.steps a ON a.workflow_id=q.workflow_id AND a.ordinal=7 JOIN ai_distill.steps r ON r.workflow_id=q.workflow_id AND r.ordinal=8
   WHERE q.workflow_id=$1 AND q.ordinal=4 AND q.status='succeeded' AND a.status='succeeded' AND a.result->>'decision'='accepted' AND r.status='succeeded'`,[workflowId])).rows[0];
  const initial=await snapshot();
  if(!initial||initial.archive.question_version!==initial.question.question_version||initial.archive.rubric_version!==initial.question.rubric_version)throw new SyncError('feishu_current_archive_required');
  // 用归档来源摘要限定回执，避免晚到回执覆盖新归档。
  archiveId=initial.archive.source_digest;archiveAttemptId=initial.archive_attempt_id;
  // 生成器自行管理事务；先归还连接再导出，避免占满池后等待第二条连接。
  db.release();connectionHeld=false;
  if(!initial.authoring_input)throw new VerificationError('feishu_authoring_materials_missing',['材料来源']);
  let exported:Awaited<ReturnType<typeof exportCurrentMaterialDocx>>;
  try{exported=await exportCurrentMaterialDocx(pool,workflowId,storageRoot,assetRoot,undefined,{expectedAuthoringInput:initial.authoring_input});}
  catch(error){if(error instanceof HTTPException&&error.status===409)throw new VerificationError('feishu_material_validation_failed',['附件数量/大小/版本/SHA-256']);throw error;}
  verification.materials='passed';
  const files:NonNullable<Awaited<ReturnType<typeof readCurrentMaterialDocx>>>[]=[];
  for(const artifact of exported.artifacts){
   const file=await readCurrentMaterialDocx(pool,artifact.artifact_id,assetRoot);
   if(!file)throw new SyncError('feishu_attachment_missing');files.push(file);
  }
  db=await pool.connect();connectionHeld=true;
  // PgBouncer事务池不保证跨事务会话一致；锁必须位于同一显式事务中，并随事务结束释放。
  await db.query('BEGIN');transaction=true;
  // 兼容首次实测版残留的同题会话锁：仅在当前后端确实拥有该锁时释放，不触碰其他任务。
  await db.query("SELECT pg_advisory_unlock(hashtext('feishu-workflow'),hashtext($1))",[workflowId]);
  const locked=(await db.query("SELECT pg_try_advisory_xact_lock(hashtext('feishu-workflow-v2'),hashtext($1)) AS locked",[workflowId])).rows[0]?.locked===true;
  if(!locked)return{status:'in_progress'};

  const lockedSnapshot=await snapshot();
  if(!lockedSnapshot||lockedSnapshot.archive_attempt_id!==archiveAttemptId||lockedSnapshot.archive.source_digest!==archiveId)throw new VerificationError('feishu_source_changed',['题目版本']);
  const api=await feishuClient(),tables=await api.list(`/bitable/v1/apps/${base}/tables`);
  const phase='table_name' in target?target.table_name:String(context.phase_name??'').trim();
  if(!tableId&&!phase)throw new SyncError('feishu_phase_missing');
  if(!tableId){
   const matches=tables.filter(x=>x.name===phase);if(matches.length>1)throw new SyncError('feishu_duplicate_phase_tables');
   tableId=matches[0]?.table_id;
   if(!tableId){
    const tableLock=(await db.query("SELECT pg_try_advisory_xact_lock(hashtext('feishu-base-v2'),hashtext($1)) AS locked",[base])).rows[0]?.locked===true;
    if(!tableLock)throw new SyncError('feishu_table_creation_busy');
    {
     const fresh=(await api.list(`/bitable/v1/apps/${base}/tables`)).filter(x=>x.name===phase);
     if(fresh.length>1)throw new SyncError('feishu_duplicate_phase_tables');
     tableId=fresh[0]?.table_id;
     if(!tableId){
      tableId=(await createFeishuTable(api,base,phase)).table_id;
     }
    }
   }
  }
  if(typeof tableId!=='string')throw new SyncError('feishu_table_missing');
  // 先查远端稳定题目ID；请求幂等ID只属于一次创建，不承担题目身份。
  const previousReceipt=lockedSnapshot.archive.feishu_deliveries?.[`${base}/${tableId}`]??lockedSnapshot.archive.feishu_sync;
  const path=`/bitable/v1/apps/${base}/tables/${tableId}`;
  await ensureFeishuSchema(api,base,tableId);
  // 同表创建/空行清理串行，避免两个题目同时删除同一占位行。
  const tableWriteLock=(await db.query("SELECT pg_try_advisory_xact_lock(hashtext('feishu-table-write'),hashtext($1)) AS locked",[`${base}/${tableId}`])).rows[0]?.locked===true;
  if(!tableWriteLock)return{status:'in_progress'};
  await removeEmptyFeishuRows(api,base,tableId,storageRoot);
  const matches=(await api.list(path+'/records')).filter(r=>r.fields?.['系统同步ID']===workflowId||r.fields?.['题目ID']===workflowId);
  if(matches.length>1)throw new VerificationError('feishu_duplicate_question_records',['题目ID重复']);
  const existing=matches[0];
  const expected=feishuTextFields(workflowId,initial.question);
  const assertCurrent=async()=>{
   const latest=await snapshot();
   if(!latest||latest.archive_attempt_id!==archiveAttemptId||latest.archive.source_digest!==archiveId||canonicalJson(latest.question)!==canonicalJson(initial.question)||canonicalJson(latest.authoring_input)!==canonicalJson(initial.authoring_input))throw new VerificationError('feishu_source_changed',['题目版本']);
  };
  const verify=async(recordId:string,uploadedTokens?:string[])=>{
   const readback=await api.call(path+'/records/'+recordId),actual=readback.record?.fields??{};
   const differences=compareFeishuText(expected,actual);
   const remoteFiles=actual['输入附件'];
   const names=files.map(file=>`材料-${createHash('sha256').update(file.bytes).digest('hex').slice(0,16)}.docx`);
   if(!Array.isArray(remoteFiles)||remoteFiles.length!==files.length||remoteFiles.some((file:any,index:number)=>uploadedTokens?!uploadedTokens.includes(file.file_token):file.name!==names[index]))differences.push({field:'输入附件',expected_length:files.length,actual_length:Array.isArray(remoteFiles)?remoteFiles.length:null,first_difference:0});
   await assertCurrent();
   verification={...verification,status:differences.length?'failed':'passed',checked_at:new Date().toISOString(),question_version:initial.question.question_version,rubric_version:initial.question.rubric_version,differences};
   if(differences.length)throw new VerificationError('feishu_record_readback_mismatch',differences.map(x=>x.field));
  };
  if(existing){
   // 兼容旧记录，仅补空白业务ID；已有不同ID属于冲突，不覆盖正文或人工ID。
   if(!existing.fields?.['题目ID'])await api.call(path+'/records/'+existing.record_id,'PUT',{fields:{'题目ID':workflowId}});
   await verify(existing.record_id);
   const receipt={status:'succeeded',table_id:tableId,record_id:existing.record_id,source_digest:archiveId,base_token:base,url:`https://ncn9ze979yuh.feishu.cn/base/${base}?table=${tableId}`,synced_at:new Date().toISOString(),reused:true,verification};
   await save(receipt);await db.query('COMMIT');transaction=false;return receipt;
  }

  if(previousReceipt?.status==='succeeded'&&previousReceipt.base_token===base&&previousReceipt.table_id===tableId&&!allowRecreateDeleted)return{...previousReceipt,status:'remote_deleted',reason_code:'feishu_record_deleted'};

  const attachments=[];
  for(const file of files){
   const hash=createHash('sha256').update(file.bytes).digest('hex').slice(0,16);
   const filename=`材料-${hash}.docx`;
   const form=new FormData();form.set('file_name',filename);form.set('parent_type','bitable_file');form.set('parent_node',base);form.set('size',String(file.bytes.length));form.set('file',new Blob([new Uint8Array(file.bytes)]),filename);
   const uploaded=await api.call('/drive/v1/medias/upload_all','POST',form);
   if(typeof uploaded.file_token!=='string')throw new SyncError('feishu_upload_missing_token');
   attachments.push({file_token:uploaded.file_token});
  }
  const current=await snapshot();
  if(!current||current.archive_attempt_id!==archiveAttemptId||current.archive.source_digest!==archiveId||current.question.question_version!==initial.question.question_version||current.question.rubric_version!==initial.question.rubric_version)throw new VerificationError('feishu_source_changed',['题目版本']);
  const body={fields:{...expected,'输入附件':attachments}};
  await assertCurrent();
  // 一次创建只生成一个随机请求ID；不因失败自动换ID重发。
  const createClientToken=crypto.randomUUID();
  const result=await api.call(path+`/records?client_token=${createClientToken}`,'POST',body);
  const recordId=result.record?.record_id;
  if(typeof recordId!=='string')throw new SyncError('feishu_record_id_missing');
  await verify(recordId,attachments.map(item=>item.file_token));
  const receipt={status:'succeeded',table_id:tableId,record_id:recordId,verification,create_client_token:createClientToken,source_digest:archiveId,base_token:base,url:`https://ncn9ze979yuh.feishu.cn/base/${base}?table=${tableId}`,synced_at:new Date().toISOString()};
  await save(receipt);await db.query('COMMIT');transaction=false;return receipt;
 }catch(error){
  const reason=error instanceof SyncError||error instanceof VerificationError?error.code:'feishu_request_failed';
  if(error instanceof VerificationError)verification={...verification,status:'failed',reason_code:error.code,fields:error.fields};
  const receipt={status:'failed',verification,workflow_id:workflowId,base_token:base,...(tableId?{table_id:tableId,url:`https://ncn9ze979yuh.feishu.cn/base/${base}?table=${tableId}`}:{ }),reason_code:reason,checked_at:new Date().toISOString()};
  if(transaction){await db.query('ROLLBACK');transaction=false;}
  if(archiveId)await save(receipt);
  logEvent('publication.feishu_sync_failed',{level:'warn',workflow_id:workflowId,reason_code:reason});return receipt;
 }finally{
  let releaseError:Error|undefined;
  try{if(transaction)await db.query('ROLLBACK');}
  catch{releaseError=new Error('feishu_lock_release_failed');}
  finally{if(connectionHeld)db.release(releaseError);}
 }
 async function save(receipt:unknown){
  const payload=JSON.stringify(receipt),destination=`${base}/${tableId??('table_name' in target?target.table_name:'unknown')}`;
  const savedReceipt=await (connectionHeld?db:pool).query(`WITH saved AS (
   UPDATE ai_distill.step_attempts SET result=result||jsonb_build_object('feishu_sync',$2::jsonb,'feishu_deliveries',COALESCE(result->'feishu_deliveries','{}'::jsonb)||jsonb_build_object($5::text,$2::jsonb))
   WHERE workflow_id=$1 AND id=$4 AND ordinal=8 AND status='succeeded' AND result->>'source_digest'=$3
    AND id=(SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=8 ORDER BY attempt DESC LIMIT 1)
   RETURNING workflow_id
  ) UPDATE ai_distill.steps SET result=result||jsonb_build_object('feishu_sync',$2::jsonb,'feishu_deliveries',COALESCE(result->'feishu_deliveries','{}'::jsonb)||jsonb_build_object($5::text,$2::jsonb))
   WHERE workflow_id=$1 AND ordinal=8 AND status='succeeded' AND result->>'source_digest'=$3 AND EXISTS(SELECT 1 FROM saved)`,[workflowId,payload,archiveId,archiveAttemptId,destination]);
  if((receipt as {status?:string}).status==='succeeded'&&!savedReceipt.rowCount)throw new VerificationError('feishu_source_changed',['归档版本']);
 }
}

