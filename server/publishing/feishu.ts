/**
 * 职责：豆包题目的飞书草稿上传及达标归档后交付；上传当前冻结材料DOCX并更新同一目标表内的题目记录。
 * 入口：syncAuthoredWorkflowToFeishu()供显式草稿上传，syncArchivedWorkflowToFeishu()供归档worker与显式补传；失败不改写出题/归档状态。
 * 边界：只启用豆包法律与医疗两个主项目，期次目标按主项目分别冻结；凭证仅从服务端环境读取，远端响应正文不进入公开错误或日志。
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
 return syncWorkflowToFeishu(pool,workflowId,storageRoot,assetRoot,'archived',targetOverride,allowRecreateDeleted);
}

/** 显式上传当前出题结果为未完成草稿；不要求达标/归档，也不更改工作流步骤。 */
export async function syncAuthoredWorkflowToFeishu(pool:Pool,workflowId:string,storageRoot:string,assetRoot:string,targetOverride?:FeishuTarget,revisionAttemptId?:string){
 return syncWorkflowToFeishu(pool,workflowId,storageRoot,assetRoot,'draft',targetOverride,false,revisionAttemptId);
}

async function syncWorkflowToFeishu(pool:Pool,workflowId:string,storageRoot:string,assetRoot:string,stage:'draft'|'archived',targetOverride?:FeishuTarget,allowRecreateDeleted=false,revisionAttemptId?:string){
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
 let api:Awaited<ReturnType<typeof feishuClient>>|undefined;
 try{
  const snapshot=async()=>{
   if(stage==='archived')return(await db.query(`SELECT q.result AS question,a.result AS acceptance,r.result AS archive,(SELECT input FROM ai_distill.step_attempts WHERE workflow_id=q.workflow_id AND ordinal=4 AND status='succeeded' AND result->>'question_version'=q.result->>'question_version' AND result->>'rubric_version'=q.result->>'rubric_version' ORDER BY attempt DESC LIMIT 1) AS authoring_input,(SELECT id FROM ai_distill.step_attempts WHERE workflow_id=q.workflow_id AND ordinal=8 AND status='succeeded' ORDER BY attempt DESC LIMIT 1) AS archive_attempt_id
    FROM ai_distill.steps q JOIN ai_distill.steps a ON a.workflow_id=q.workflow_id AND a.ordinal=7 JOIN ai_distill.steps r ON r.workflow_id=q.workflow_id AND r.ordinal=8
    WHERE q.workflow_id=$1 AND q.ordinal=4 AND q.status='succeeded' AND a.status='succeeded' AND a.result->>'decision'='accepted' AND r.status='succeeded'`,[workflowId])).rows[0];
   return(await db.query(`SELECT q.result AS question,(SELECT input FROM ai_distill.step_attempts WHERE workflow_id=q.workflow_id AND ordinal=4 AND status='succeeded' AND result->>'question_version'=q.result->>'question_version' AND result->>'rubric_version'=q.result->>'rubric_version' ORDER BY attempt DESC LIMIT 1) AS authoring_input
    FROM ai_distill.steps q JOIN ai_distill.workflows w ON w.id=q.workflow_id
    WHERE q.workflow_id=$1 AND q.ordinal=4 AND q.status='succeeded' AND w.workflow_kind='question'
     AND NOT EXISTS(SELECT 1 FROM ai_distill.steps archived WHERE archived.workflow_id=q.workflow_id AND archived.ordinal=8 AND archived.status='succeeded')`,[workflowId])).rows[0];
  };
  const snapshotKey=(value:any)=>stage==='archived'?value?.archive?.source_digest:createHash('sha256').update(canonicalJson({question_version:value?.question?.question_version,rubric_version:value?.question?.rubric_version,authoring_input:value?.authoring_input})).digest('hex');
  const initial=await snapshot();
  if(!initial||!initial.question||!initial.authoring_input||!initial.question.question_version||!initial.question.rubric_version)throw new SyncError(stage==='archived'?'feishu_current_archive_required':'feishu_current_authoring_required');
  if(stage==='archived'&&(initial.archive.question_version!==initial.question.question_version||initial.archive.rubric_version!==initial.question.rubric_version))throw new SyncError('feishu_current_archive_required');
  // 草稿用出题版本和冻结输入生成本地比较键；正式交付仍使用归档摘要与attempt身份。
  archiveId=snapshotKey(initial);archiveAttemptId=initial.archive_attempt_id;
  // 生成器自行管理事务；先归还连接再导出，避免占满池后等待第二条连接。
  db.release();connectionHeld=false;
  if(!initial.authoring_input)throw new VerificationError('feishu_authoring_materials_missing',['材料来源']);
  // 以本次有效出题attempt的冻结输入校验材料来源，再由导出器按来源决定附件数量：
  // 普通豆包材料按项目布局合册；选用材料快照逐文书导出。这里不自行拼接正文或改变顺序。
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
  if(!lockedSnapshot||snapshotKey(lockedSnapshot)!==archiveId||(stage==='archived'&&lockedSnapshot.archive_attempt_id!==archiveAttemptId))throw new VerificationError('feishu_source_changed',['题目版本']);
  api=await feishuClient();const tables=await api.list(`/bitable/v1/apps/${base}/tables`);
  const remote=api;
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
  const previousReceipt=stage==='archived'?(lockedSnapshot.archive.feishu_deliveries?.[`${base}/${tableId}`]??lockedSnapshot.archive.feishu_sync):undefined;
  const path=`/bitable/v1/apps/${base}/tables/${tableId}`;
  await ensureFeishuSchema(api,base,tableId);
  // 同表写入串行；仅既有归档同步清理空占位行，草稿上传不删除表内记录。
  const tableWriteLock=(await db.query("SELECT pg_try_advisory_xact_lock(hashtext('feishu-table-write'),hashtext($1)) AS locked",[`${base}/${tableId}`])).rows[0]?.locked===true;
  if(!tableWriteLock)return{status:'in_progress'};
  if(stage==='archived')await removeEmptyFeishuRows(api,base,tableId,storageRoot);
  const matches=(await api.list(path+'/records')).filter(r=>r.fields?.['系统同步ID']===workflowId||r.fields?.['题目ID']===workflowId);
  if(matches.length>1)throw new VerificationError('feishu_duplicate_question_records',['题目ID重复']);
  const existing=matches[0];
  const expected=feishuTextFields(workflowId,initial.question,stage==='draft'?'未完成':'已完成');
  // 普通重试保留已上传旧版编号，不因展示改版覆盖正文；仍逐字符验证同版全部字段。
  const legacyExpected=feishuTextFields(workflowId,initial.question,stage==='draft'?'未完成':'已完成','legacy');
  if(existing&&!revisionAttemptId&&existing.fields?.['考点rubric']===legacyExpected['考点rubric'])expected['考点rubric']=legacyExpected['考点rubric']!;
  // 飞书附件名按实际DOCX字节摘要生成；多个导出件依导出顺序逐个上传到同一题的“输入附件”。
  // 名称供已有记录比对，不代表远端文件字节已重新下载核验。
  const currentAttachmentNames=files.map(file=>`材料-${createHash('sha256').update(file.bytes).digest('hex').slice(0,16)}.docx`);
  const hasAttachmentNames=(value:unknown,names:string[])=>Array.isArray(value)&&value.length===names.length&&value.every((file:any,index:number)=>file?.name===names[index]);
  const uploadCurrentAttachments=async()=>{
   const attachments=[];
   for(const [index,file] of files.entries()){
    const filename=currentAttachmentNames[index]!;
    const form=new FormData();form.set('file_name',filename);form.set('parent_type','bitable_file');form.set('parent_node',base);form.set('size',String(file.bytes.length));form.set('file',new Blob([new Uint8Array(file.bytes)]),filename);
    const uploaded=await api!.call('/drive/v1/medias/upload_all','POST',form);
    if(typeof uploaded.file_token!=='string')throw new SyncError('feishu_upload_missing_token');
    attachments.push({file_token:uploaded.file_token});
   }
   return attachments;
  };
  const assertCurrent=async()=>{
   const latest=await snapshot();
   if(!latest||snapshotKey(latest)!==archiveId||(stage==='archived'&&latest.archive_attempt_id!==archiveAttemptId)||canonicalJson(latest.question)!==canonicalJson(initial.question)||canonicalJson(latest.authoring_input)!==canonicalJson(initial.authoring_input))throw new VerificationError('feishu_source_changed',['题目版本']);
  };
  // 新记录回读本次上传token；已有记录回读摘要文件名、数量及顺序，并逐字符核对题目字段。
  // 此处不下载飞书附件，故成功回执只证明记录字段和附件关联的回读结果。
  const verify=async(recordId:string,uploadedTokens?:string[])=>{
   let readback=await remote.call(path+'/records/'+recordId),actual=readback.record?.fields??{};
   const compare=()=>{
    const differences=compareFeishuText(expected,actual),remoteFiles=actual['输入附件'];
    if(!Array.isArray(remoteFiles)||remoteFiles.length!==files.length||remoteFiles.some((file:any,index:number)=>uploadedTokens?!uploadedTokens.includes(file.file_token):file.name!==currentAttachmentNames[index]))differences.push({field:'输入附件',expected_length:files.length,actual_length:Array.isArray(remoteFiles)?remoteFiles.length:null,first_difference:0});
    return differences;
   };
   let differences=compare();
   if(stage==='archived'&&actual['题目是否完成']==='未完成'&&!differences.some((difference:any)=>difference.field!=='题目是否完成')){
    await assertCurrent();await remote.call(path+'/records/'+recordId,'PUT',{fields:{'题目是否完成':'已完成'}});
    readback=await remote.call(path+'/records/'+recordId);actual=readback.record?.fields??{};differences=compare();
   }
   await assertCurrent();
   verification={...verification,status:differences.length?'failed':'passed',checked_at:new Date().toISOString(),question_version:initial.question.question_version,rubric_version:initial.question.rubric_version,differences};
   if(differences.length)throw new VerificationError('feishu_record_readback_mismatch',differences.map(x=>x.field));
  };
  let revisionUploadedTokens:string[]|undefined;
  if(existing&&revisionAttemptId){
   const revision=initial.question.manual_revision;
   if(stage!=='draft'||revision?.attempt_id!==revisionAttemptId)throw new VerificationError('feishu_revision_mismatch',['题目版本']);
   const readback=await remote.call(path+'/records/'+existing.record_id),actual=readback.record?.fields??{};
   const beforeQuestion=revision.kind==='subject_names'
    ?revision.before?.question??revision.before
    :{...initial.question,...(revision.before&&typeof revision.before==='object'?revision.before:{question:revision.before})};
   const afterQuestion=revision.after?.question;
   if(revision.kind==='subject_names'){
    if(!beforeQuestion||!afterQuestion||!revision.before?.material_binding||!revision.after?.material_binding)throw new VerificationError('feishu_revision_binding_missing',['题目版本','材料来源']);
    const afterBinding={snapshot_digest:initial.authoring_input.material_origin?.snapshot_digest,materials:initial.authoring_input.materials};
    if(canonicalJson(afterBinding)!==canonicalJson(revision.after.material_binding)||canonicalJson(feishuTextFields(workflowId,afterQuestion,'未完成'))!==canonicalJson(expected))throw new VerificationError('feishu_revision_mismatch',['题目版本','材料来源']);
   }
   // 明确修订只允许从已绑定旧值迁移；若远端已经是新值和新附件，则只执行回读核验。
   const currentDifferences=compareFeishuText(expected,actual),currentAttachments=hasAttachmentNames(actual['输入附件'],currentAttachmentNames);
   if(currentDifferences.length||!currentAttachments){
    const recordedStatus=revision.before?.completion_status==='已完成'?'已完成':'未完成';
    const priorComparisons=[recordedStatus,recordedStatus==='已完成'?'未完成':'已完成'].flatMap(status=>(['numbered','legacy'] as const).map(layout=>compareFeishuText(feishuTextFields(workflowId,beforeQuestion,status as '已完成'|'未完成',layout),actual)));
    const differences=priorComparisons.find(items=>items.length===0)??priorComparisons[0]!;
    const previousAttachmentNames=revision.before?.attachment_names;
    const subjectNameRevision=revision.kind==='subject_names',previousAttachmentsMatch=Array.isArray(previousAttachmentNames)&&previousAttachmentNames.length>0&&hasAttachmentNames(actual['输入附件'],previousAttachmentNames);
    if(differences.length||(subjectNameRevision?!previousAttachmentsMatch:!currentAttachments))throw new VerificationError('feishu_revision_old_value_conflict',[...differences.map((d:any)=>d.field),...((subjectNameRevision?previousAttachmentsMatch:currentAttachments)?[]:['输入附件'])]);
    const mutableFields=['任务名称','任务类型','prompt','考点rubric','作答思路','标准答案-文本','题目是否完成'];
    const fields:Record<string,unknown>=Object.fromEntries(mutableFields.filter(key=>actual[key]!==expected[key]).map(key=>[key,expected[key]]));
    if(subjectNameRevision){const uploaded=await uploadCurrentAttachments();fields['输入附件']=uploaded;revisionUploadedTokens=uploaded.map(item=>item.file_token);}
    await assertCurrent();
    await remote.call(path+'/records/'+existing.record_id,'PUT',{fields});
    const after=(await remote.call(path+'/records/'+existing.record_id)).record?.fields??{},allowed=new Set(Object.keys(fields));
    for(const key of new Set([...Object.keys(actual),...Object.keys(after)]))if(!allowed.has(key)&&canonicalJson(actual[key]??null)!==canonicalJson(after[key]??null))throw new VerificationError('feishu_unrelated_field_changed',[key]);
   }
  }
  if(existing){
   // 兼容旧记录，仅补空白业务ID；已有不同ID属于冲突，不覆盖正文或人工ID。
   if(!existing.fields?.['题目ID'])await api.call(path+'/records/'+existing.record_id,'PUT',{fields:{'题目ID':workflowId}});
   await verify(existing.record_id,revisionUploadedTokens);
   const receipt={status:'succeeded',stage,table_id:tableId,record_id:existing.record_id,source_digest:archiveId,base_token:base,url:`https://ncn9ze979yuh.feishu.cn/base/${base}?table=${tableId}`,synced_at:new Date().toISOString(),reused:true,verification};
   if(stage==='archived')await save(receipt);await db.query('COMMIT');transaction=false;return receipt;
  }

  if(previousReceipt?.status==='succeeded'&&previousReceipt.base_token===base&&previousReceipt.table_id===tableId&&!allowRecreateDeleted)return{...previousReceipt,status:'remote_deleted',reason_code:'feishu_record_deleted'};

  const attachments=await uploadCurrentAttachments();
  const current=await snapshot();
  if(!current||snapshotKey(current)!==archiveId||(stage==='archived'&&current.archive_attempt_id!==archiveAttemptId)||current.question.question_version!==initial.question.question_version||current.question.rubric_version!==initial.question.rubric_version)throw new VerificationError('feishu_source_changed',['题目版本']);
  const body={fields:{...expected,'输入附件':attachments}};
  await assertCurrent();
  // 一次创建只生成一个随机请求ID；不因失败自动换ID重发。
  const createClientToken=crypto.randomUUID();
  const result=await api.call(path+`/records?client_token=${createClientToken}`,'POST',body);
  const recordId=result.record?.record_id;
  if(typeof recordId!=='string')throw new SyncError('feishu_record_id_missing');
  await verify(recordId,attachments.map(item=>item.file_token));
  const receipt={status:'succeeded',stage,table_id:tableId,record_id:recordId,verification,create_client_token:createClientToken,source_digest:archiveId,base_token:base,url:`https://ncn9ze979yuh.feishu.cn/base/${base}?table=${tableId}`,synced_at:new Date().toISOString()};
  if(stage==='archived')await save(receipt);await db.query('COMMIT');transaction=false;return receipt;
 }catch(error){
  const reason=error instanceof SyncError||error instanceof VerificationError?error.code:'feishu_request_failed';
  if(error instanceof VerificationError)verification={...verification,status:'failed',reason_code:error.code,fields:error.fields};
  const receipt={status:'failed',stage,verification,workflow_id:workflowId,base_token:base,...(tableId?{table_id:tableId,url:`https://ncn9ze979yuh.feishu.cn/base/${base}?table=${tableId}`}:{ }),reason_code:reason,checked_at:new Date().toISOString()};
  if(transaction){await db.query('ROLLBACK');transaction=false;}
  if(stage==='archived'&&archiveId)await save(receipt);
  logEvent(stage==='archived'?'publication.feishu_sync_failed':'publication.feishu_draft_sync_failed',{level:'warn',workflow_id:workflowId,reason_code:reason});return receipt;
 }finally{
  let releaseError:Error|undefined;
  try{if(transaction)await db.query('ROLLBACK');}
  catch{releaseError=new Error('feishu_lock_release_failed');}
  finally{try{await api?.close();}finally{if(connectionHeld)db.release(releaseError);}}
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

