/**
 * 职责：工作流题目的飞书草稿上传及达标归档后交付；复用共用交付引擎 feishu-delivery.ts，校验冻结材料DOCX并按需转换图像PDF后同步目标表。
 * 入口：syncAuthoredWorkflowToFeishu()供显式草稿上传，syncArchivedWorkflowToFeishu()供归档worker与显式补传；另导出共用交付函数供跨模块调用。
 * 边界：默认目标按主项目配置/冻结路由解析，显式 target 支持任意已配置或指定目标表的项目；失败不改写出题或本地归档状态。
 */
import type {Pool,PoolClient} from 'pg';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HTTPException} from 'hono/http-exception';
import {exportCurrentMaterialDocx,readCurrentMaterialDocx,readCurrentRedactionForDocx} from '../materials/redacted-docx-export';
import {logEvent} from '../logging';
import {canonicalJson} from '../../shared/workflow-config';
import {isEvaluationPipelineSealed} from '../../shared/step-registry';
import {VerificationError} from './feishu-verification';
import {SyncError,createFeishuTable} from './feishu-api';
import {readFeishuDeliveryConfig,validateFeishuTarget,type FeishuTarget,type FeishuAttachmentFormat} from './feishu-targets';
import {materialPdfAttachments,peekCachedMaterialPdfNames,materialPdfBaseNames,materialCleanPdfBaseNames,isLegacyHashAttachmentList,COMBINED_MATERIAL_PDF_STEM} from './material-pdf';
import {
 clearFeishuDeliverySessionCache,
 createFeishuDeliverySession,
 deliverQuestionToFeishu,
 hasExactAttachmentNames,
 uploadFeishuAttachments,
 type FeishuDeliverySession,
 type DeliverQuestionToFeishuOptions,
} from './feishu-delivery';

export {
 clearFeishuDeliverySessionCache,
 createFeishuDeliverySession,
 deliverQuestionToFeishu,
 uploadFeishuAttachments,
 type FeishuDeliverySession,
 type DeliverQuestionToFeishuOptions,
};

const DOUBAO_LEGAL_GROUP='315407cd-43db-49d1-8eb3-c2dff77af859';
const DOUBAO_REVISION_GROUP='95e1e1d7-a567-4d48-90a6-3191821d93d6';
const TABLE_WRITE_LOCK_WAIT_MS=15_000;
const TABLE_WRITE_LOCK_POLL_MS=250;

async function readRevisionOrigin(db:Pick<Pool,'query'>,workflowId:string):Promise<{orig_workflow_id:string;orig_task_name:string}|null>{
 const row=(await db.query(`
  SELECT ow.id AS orig_workflow_id, COALESCE(os4.result->>'task_name','') AS orig_task_name
  FROM ai_distill.workflows w
  JOIN ai_distill.projects p ON p.id=w.project_id
  LEFT JOIN ai_distill.question_library_sources qls ON qls.workflow_id=w.id
  LEFT JOIN ai_distill.question_library_sources oqls ON oqls.package_id=qls.package_id AND oqls.project_id<>w.project_id
  LEFT JOIN ai_distill.workflows ow ON ow.id=COALESCE(w.source_workflow_id,oqls.workflow_id) AND ow.deleted_at IS NULL
  LEFT JOIN ai_distill.projects op ON op.id=ow.project_id AND op.deleted_at IS NULL AND op.phase_name=p.phase_name
  LEFT JOIN ai_distill.steps os4 ON os4.workflow_id=ow.id AND os4.ordinal=4 AND os4.status='succeeded'
  WHERE w.id=$1 AND ow.id IS NOT NULL
  ORDER BY (ow.id=w.source_workflow_id) DESC NULLS LAST, (op.id IS NOT NULL) DESC NULLS LAST, ow.created_at DESC NULLS LAST
  LIMIT 1
 `,[workflowId])).rows[0];
 if(!row?.orig_workflow_id)return null;
 return{orig_workflow_id:String(row.orig_workflow_id),orig_task_name:String(row.orig_task_name??'')};
}

/** 飞书单个附件字段容纳不了超长分件列表时，保留每份独立 DOCX 于一个 ZIP。 */
async function bundleDocxParts(files:NonNullable<Awaited<ReturnType<typeof readCurrentMaterialDocx>>>[],names:string[]){
 const directory=await mkdtemp(join(tmpdir(),'ai-distill-feishu-parts-'));
 try{
  for(const [index,file] of files.entries())await writeFile(join(directory,names[index]!),file.bytes,{mode:0o600,flag:'wx'});
  const output=join(directory,'分件材料.zip');
  // Python zipfile 为非 ASCII 条目写入 UTF-8 标志；系统 zip 在部分 macOS 环境下会使中文名乱码。
  const script='import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1], "w", compression=zipfile.ZIP_STORED) as archive:\n for name in sys.argv[2:]: archive.write(name, arcname=name)';
  const child=Bun.spawn({cmd:[process.env.PYTHON3_PATH??'python3','-c',script,output,...names],cwd:directory,stdout:'ignore',stderr:'pipe'});
  if(await child.exited!==0)throw new SyncError('feishu_material_zip_failed');
  return{bytes:await readFile(output),name:`分件材料（${names.length}份）.zip`};
 }finally{await rm(directory,{recursive:true,force:true});}
}

/** 可见题目ID与隐藏系统ID均关联workflow UUID；普通文本字段不锁定或冻结。 */
export async function syncArchivedWorkflowToFeishu(pool:Pool,workflowId:string,storageRoot:string,assetRoot:string,targetOverride?:FeishuTarget,allowRecreateDeleted=false,attachmentFormatOverride?:FeishuAttachmentFormat,combinedMaterial=false,expectedAuthor?:string,session?:FeishuDeliverySession){
 return syncWorkflowToFeishu(pool,workflowId,storageRoot,assetRoot,'archived',targetOverride,allowRecreateDeleted,undefined,attachmentFormatOverride,combinedMaterial,undefined,expectedAuthor,session);
}

/** 显式上传当前出题结果为未完成草稿；不要求达标/归档，也不更改工作流步骤。 */
export async function syncAuthoredWorkflowToFeishu(pool:Pool,workflowId:string,storageRoot:string,assetRoot:string,targetOverride?:FeishuTarget,revisionAttemptId?:string,attachmentFormatOverride?:FeishuAttachmentFormat,combinedMaterial=false,replaceRecordId?:string,expectedAuthor?:string,session?:FeishuDeliverySession){
 return syncWorkflowToFeishu(pool,workflowId,storageRoot,assetRoot,'draft',targetOverride,false,revisionAttemptId,attachmentFormatOverride,combinedMaterial,replaceRecordId,expectedAuthor,session);
}

async function syncWorkflowToFeishu(
 pool:Pool,
 workflowId:string,
 storageRoot:string,
 assetRoot:string,
 stage:'draft'|'archived',
 targetOverride?:FeishuTarget,
 allowRecreateDeleted=false,
 revisionAttemptId?:string,
 attachmentFormatOverride?:FeishuAttachmentFormat,
 combinedMaterial=false,
 replaceRecordId?:string,
 expectedAuthor?:string,
 sharedSession?:FeishuDeliverySession,
){
 workflowId=workflowId.toLowerCase();
 const context=(await pool.query(`SELECT w.project_id,p.project_group_id,p.phase_name FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id WHERE w.id=$1 AND w.deleted_at IS NULL AND p.deleted_at IS NULL`,[workflowId])).rows[0];
 if(!context)return{status:'not_applicable'};
 const settings=await readFeishuDeliveryConfig(pool,String(context.project_id));
 if(!settings)return{status:'not_applicable'};
 const target=targetOverride?validateFeishuTarget(targetOverride):settings.default_target;
 if(!target)return{status:'not_applicable'};
 const resolvedDefaultTarget=target;
 const attachmentFormat:FeishuAttachmentFormat=attachmentFormatOverride??settings.attachment_format??'docx';
 combinedMaterial=combinedMaterial||String(context.project_group_id)===DOUBAO_LEGAL_GROUP||String(context.project_group_id)===DOUBAO_REVISION_GROUP;
 const base=resolvedDefaultTarget.base_token;
 let tableId='table_id' in resolvedDefaultTarget?resolvedDefaultTarget.table_id:undefined;
 const sealed=isEvaluationPipelineSealed();
 let db:PoolClient|undefined,connectionHeld=false,transaction=false,archiveId:string|undefined,archiveAttemptId:string|undefined;
 let verification:any={status:'incomplete',checked_at:new Date().toISOString()};

 const releaseDb=async(rollbackFirst=false)=>{
  let releaseError:Error|undefined;
  try{if(rollbackFirst&&transaction&&db){await db.query('ROLLBACK');transaction=false;}}
  catch{releaseError=new Error('feishu_lock_release_failed');}
  finally{if(connectionHeld&&db){connectionHeld=false;db.release(releaseError);db=undefined;}}
 };

 try{
  db=await pool.connect();connectionHeld=true;
  const snapshot=async()=>{
   const row=stage==='archived'
    ?(await db!.query(sealed
     ?`SELECT q.result AS question,a.result AS acceptance,r.result AS archive
       FROM ai_distill.steps q LEFT JOIN ai_distill.steps a ON a.workflow_id=q.workflow_id AND a.ordinal=7 AND a.status='succeeded' AND a.result->>'decision'='accepted'
       JOIN ai_distill.steps r ON r.workflow_id=q.workflow_id AND r.ordinal=8
       WHERE q.workflow_id=$1 AND q.ordinal=4 AND q.status='succeeded' AND r.status='succeeded'`
     :`SELECT q.result AS question,a.result AS acceptance,r.result AS archive
       FROM ai_distill.steps q JOIN ai_distill.steps a ON a.workflow_id=q.workflow_id AND a.ordinal=7
       JOIN ai_distill.steps r ON r.workflow_id=q.workflow_id AND r.ordinal=8
       WHERE q.workflow_id=$1 AND q.ordinal=4 AND q.status='succeeded' AND a.status='succeeded'
        AND a.result->>'decision'='accepted' AND r.status='succeeded'`,[workflowId])).rows[0]
    :(await db!.query(`SELECT q.result AS question FROM ai_distill.steps q JOIN ai_distill.workflows w ON w.id=q.workflow_id
      WHERE q.workflow_id=$1 AND q.ordinal=4 AND q.status='succeeded' AND w.workflow_kind='question'
       AND NOT EXISTS(SELECT 1 FROM ai_distill.steps archived WHERE archived.workflow_id=$1 AND archived.ordinal=8 AND archived.status='succeeded')`,[workflowId])).rows[0];
   if(!row)return;
   const author=(await db!.query(`SELECT id,jsonb_build_object('materials',input->'materials','material_origin',input->'material_origin',
     'redaction_attempt_id',input->'redaction_attempt_id') AS input,
     encode(sha256(convert_to(input::text,'UTF8')),'hex') AS input_digest FROM ai_distill.step_attempts
    WHERE workflow_id=$1 AND ordinal=4 AND status='succeeded' AND result->>'question_version'=$2
     AND result->>'rubric_version'=$3 ORDER BY attempt DESC LIMIT 1`,[workflowId,row.question?.question_version,row.question?.rubric_version])).rows[0];
   const archive=stage==='archived'?(await db!.query(`SELECT id FROM ai_distill.step_attempts
    WHERE workflow_id=$1 AND ordinal=8 AND status='succeeded' ORDER BY attempt DESC LIMIT 1`,[workflowId])).rows[0]:undefined;
   return{...row,authoring_input:author?.input,authoring_input_digest:author?.input_digest,authoring_attempt_id:author?.id,archive_attempt_id:archive?.id};
  };
  const snapshotKey=(value:any)=>stage==='archived'?value?.archive?.source_digest:createHash('sha256').update(canonicalJson({question_version:value?.question?.question_version,rubric_version:value?.question?.rubric_version,authoring_input_digest:value?.authoring_input_digest})).digest('hex');
  const initial=await snapshot();
  if(expectedAuthor&&initial?.authoring_attempt_id!==expectedAuthor)throw new SyncError('feishu_authoring_version_changed');
  if(!initial||!initial.question||!initial.authoring_input||!initial.question.question_version||!initial.question.rubric_version)throw new SyncError(stage==='archived'?'feishu_current_archive_required':'feishu_current_authoring_required');
  if(stage==='archived'&&(initial.archive.question_version!==initial.question.question_version||initial.archive.rubric_version!==initial.question.rubric_version))throw new SyncError('feishu_current_archive_required');
  archiveId=snapshotKey(initial);archiveAttemptId=initial.archive_attempt_id;
  await releaseDb(false);

  const assertCurrentOn=async(conn:Pick<PoolClient,'query'>)=>{
   const current=(await conn.query(`SELECT q.result=$2::jsonb
      AND EXISTS(SELECT 1 FROM (
       SELECT id,input FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=4 AND status='succeeded'
        AND result->>'question_version'=$4 AND result->>'rubric_version'=$5 ORDER BY attempt DESC LIMIT 1
      ) author WHERE author.id=$6::uuid AND encode(sha256(convert_to(author.input::text,'UTF8')),'hex')=$3)
      AS unchanged
     FROM ai_distill.steps q JOIN ai_distill.workflows w ON w.id=q.workflow_id
     WHERE q.workflow_id=$1 AND q.ordinal=4 AND q.status='succeeded'
      ${stage==='draft'?`AND w.workflow_kind='question' AND NOT EXISTS(
       SELECT 1 FROM ai_distill.steps archived WHERE archived.workflow_id=$1 AND archived.ordinal=8 AND archived.status='succeeded')`:
       `${sealed?'':`AND EXISTS(SELECT 1 FROM ai_distill.steps accepted WHERE accepted.workflow_id=$1 AND accepted.ordinal=7
         AND accepted.status='succeeded' AND accepted.result->>'decision'='accepted')`}
        AND EXISTS(SELECT 1 FROM ai_distill.steps archived WHERE archived.workflow_id=$1 AND archived.ordinal=8
         AND archived.status='succeeded' AND archived.result->>'source_digest'=$7)
        AND (SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=8 AND status='succeeded'
         ORDER BY attempt DESC LIMIT 1)=$8::uuid`}`,
    [workflowId,JSON.stringify(initial.question),initial.authoring_input_digest,initial.question.question_version,
     initial.question.rubric_version,initial.authoring_attempt_id,...(stage==='archived'?[archiveId,archiveAttemptId]:[])])).rows[0];
   if(current?.unchanged!==true)throw new VerificationError('feishu_source_changed',['题目版本']);
  };

  let exported:Awaited<ReturnType<typeof exportCurrentMaterialDocx>>;
  try{exported=await exportCurrentMaterialDocx(pool,workflowId,storageRoot,assetRoot,undefined,{expectedAuthoringInput:initial.authoring_input,...(combinedMaterial?{deliveryLayout:'combined' as const}:{})});}
  catch(error){if(error instanceof HTTPException&&error.status===409)throw new VerificationError('feishu_material_validation_failed',['附件数量/大小/版本/SHA-256']);throw error;}
  verification.materials='passed';

  let files:NonNullable<Awaited<ReturnType<typeof readCurrentMaterialDocx>>>[];
  if(Array.isArray((exported as any).files)&&(exported as any).files.length===exported.artifacts.length){
   files=(exported as any).files;
  }else{
   files=[];
   const verifiedSource=await readCurrentRedactionForDocx(pool,workflowId,storageRoot);
   for(const artifact of exported.artifacts){
    const file=await readCurrentMaterialDocx(pool,artifact.artifact_id,assetRoot,{workflow_id:workflowId,source:verifiedSource});
    if(!file)throw new SyncError('feishu_attachment_missing');
    files.push(file);
   }
  }
  if(combinedMaterial&&files.length!==1)throw new SyncError('feishu_combined_attachment_count');

  const pdfSourceFiles=combinedMaterial?files.map(file=>({...file,filename:`${COMBINED_MATERIAL_PDF_STEM}.docx`})):files;
  const pdfStems=materialPdfBaseNames(files),cleanPdfStems=materialCleanPdfBaseNames(pdfSourceFiles);
  const allPdfStems=[...new Set([...cleanPdfStems,...materialCleanPdfBaseNames(files),...pdfStems])];
  const docxNames=combinedMaterial?['材料.docx']:pdfStems.map(stem=>`${stem}.docx`);
  const alternateAttachmentNames=attachmentFormat==='pdf'?docxNames:cleanPdfStems.map(stem=>`${stem}.pdf`);
  const isCombinedDocxAttachment=(value:unknown)=>hasExactAttachmentNames(value,['材料.docx']);
  const matchesSplitPdfStems=(value:unknown)=>Array.isArray(value)&&value.length>0&&value.every((file:any)=>typeof file?.name==='string'&&allPdfStems.some(stem=>file.name===`${stem}.pdf`||(file.name.startsWith(`${stem}-页`)&&file.name.endsWith('.pdf'))||(file.name.startsWith(`${stem}（第`)&&file.name.endsWith('册）.pdf'))));
  const isUpgradeableAttachmentFormat=(filesField:unknown)=>hasExactAttachmentNames(filesField,alternateAttachmentNames)||(attachmentFormat==='pdf'&&(isCombinedDocxAttachment(filesField)||matchesSplitPdfStems(filesField)))||(attachmentFormat==='docx'&&matchesSplitPdfStems(filesField))||isLegacyHashAttachmentList(filesField);

  const knownCurrentNames=attachmentFormat==='docx'
   ?(files.length>100?[`分件材料（${docxNames.length}份）.zip`]:docxNames)
   :await peekCachedMaterialPdfNames(pdfSourceFiles,workflowId,storageRoot);

  return await deliverQuestionToFeishu({
   workflowId,
   question:initial.question,
   stage,
   target:'table_id' in resolvedDefaultTarget?resolvedDefaultTarget:{base_token:base,table_name:String(resolvedDefaultTarget.table_name||context.phase_name||'').trim()},
   attachmentFormat,
   sourceDigest:archiveId,
   storageRoot,
   allowRecreateDeleted,
   revisionAttemptId,
   replaceRecordId,
   authoringMaterialBinding:{snapshot_digest:initial.authoring_input.material_origin?.snapshot_digest,materials:initial.authoring_input.materials},
   session:sharedSession,
   attachments:{
    knownCurrentNames,
    knownUpgradeableAttachmentFormat:isUpgradeableAttachmentFormat,
    async prepare(){
     if(attachmentFormat==='pdf'){
      const pdfAttachments=await materialPdfAttachments(pdfSourceFiles,workflowId,storageRoot);
      return{
       currentNames:pdfAttachments.map(file=>file.name),
       payloads:pdfAttachments.map(file=>({name:file.name,bytes:file.bytes,mimeType:'application/pdf'})),
       isUpgradeableAttachmentFormat,
      };
     }
     if(files.length>100){
      const zipped=await bundleDocxParts(files,docxNames);
      return{
       currentNames:[zipped.name],
       payloads:[{name:zipped.name,bytes:zipped.bytes,mimeType:'application/zip'}],
       forceReplaceUpload:true,
       isUpgradeableAttachmentFormat,
      };
     }
     return{
      currentNames:docxNames,
      payloads:files.map((file,index)=>({name:docxNames[index]!,bytes:file.bytes,mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'})),
      isUpgradeableAttachmentFormat,
     };
    },
   },
   async createMissingTable(api,baseToken,phase){
    db=await pool.connect();connectionHeld=true;
    try{
     await db.query('BEGIN');transaction=true;
     const tableLock=(await db.query("SELECT pg_try_advisory_xact_lock(hashtext('feishu-base-v2'),hashtext($1)) AS locked",[baseToken])).rows[0]?.locked===true;
     if(!tableLock)throw new SyncError('feishu_table_creation_busy');
     const fresh=(await api.list(`/bitable/v1/apps/${baseToken}/tables`)).filter(x=>x.name===phase);
     if(fresh.length>1)throw new SyncError('feishu_duplicate_phase_tables');
     const createdId=fresh[0]?.table_id??(await createFeishuTable(api,baseToken,phase)).table_id;
     await db.query('COMMIT');transaction=false;
     return createdId;
    }finally{
     await releaseDb(true);
    }
   },
   async withWriteCriticalSection(resolvedTarget,_tableFieldNames,run){
    tableId=resolvedTarget.table_id;
    const tableKey=`${resolvedTarget.base_token}/${resolvedTarget.table_id}`;
    const waitDeadline=Date.now()+TABLE_WRITE_LOCK_WAIT_MS;
    while(true){
     db=await pool.connect();connectionHeld=true;
     await db.query('BEGIN');transaction=true;
     await db.query("SELECT pg_advisory_unlock(hashtext('feishu-workflow'),hashtext($1))",[workflowId]);
     const workflowLocked=(await db.query("SELECT pg_try_advisory_xact_lock(hashtext('feishu-workflow-v2'),hashtext($1)) AS locked",[workflowId])).rows[0]?.locked===true;
     if(!workflowLocked){
      await releaseDb(true);
      return{kind:'aborted',receipt:{status:'in_progress'}};
     }
     const tableWriteLock=(await db.query("SELECT pg_try_advisory_xact_lock(hashtext('feishu-table-write'),hashtext($1)) AS locked",[tableKey])).rows[0]?.locked===true;
     if(tableWriteLock)break;
     await releaseDb(true);
     if(Date.now()>=waitDeadline)return{kind:'aborted',receipt:{status:'in_progress'}};
     await new Promise(resolve=>setTimeout(resolve,TABLE_WRITE_LOCK_POLL_MS));
    }
    try{
     const previousReceipt=stage==='archived'?(initial.archive?.feishu_deliveries?.[tableKey]??initial.archive?.feishu_sync):undefined;
     const value=await run({
      assertCurrent:()=>assertCurrentOn(db!),
      previousSucceededReceipt:previousReceipt,
      async resolveExtraExpectedFields(fields){
       if(!fields.has('旧题目ID')&&!fields.has('旧任务名称'))return{};
       const origin=await readRevisionOrigin(db!,workflowId);
       if(!origin)return{};
       const extra:Record<string,string>={};
       if(fields.has('旧题目ID'))extra['旧题目ID']=origin.orig_workflow_id;
       if(fields.has('旧任务名称'))extra['旧任务名称']=origin.orig_task_name;
       return extra;
      },
      saveReceipt:async(receipt)=>{
       if(stage==='archived')await save(receipt,resolvedTarget.table_id);
      },
     });
     await db!.query('COMMIT');transaction=false;
     return{kind:'completed',value};
    }finally{
     await releaseDb(true);
    }
   },
  });
 }catch(error:any){
  const reason=error instanceof SyncError||error instanceof VerificationError?error.code:'feishu_request_failed';
  if(error?.feishu_verification)verification=error.feishu_verification;
  else if(error instanceof VerificationError)verification={...verification,status:'failed',reason_code:error.code,fields:error.fields};
  if(typeof error?.feishu_resolved_table_id==='string')tableId=error.feishu_resolved_table_id;
  await releaseDb(true);
  const receipt={status:'failed',stage,attachment_format:attachmentFormat,verification,workflow_id:workflowId,base_token:base,...(tableId?{table_id:tableId,url:`https://ncn9ze979yuh.feishu.cn/base/${base}?table=${tableId}`}:{}),reason_code:reason,checked_at:new Date().toISOString()};
  if(stage==='archived'&&archiveId)await save(receipt,tableId);
  logEvent(stage==='archived'?'publication.feishu_sync_failed':'publication.feishu_draft_sync_failed',{level:'warn',workflow_id:workflowId,reason_code:reason});
  return receipt;
 }finally{
  await releaseDb(true);
 }

 async function save(receipt:unknown,resolvedTableId?:string){
  const payload=JSON.stringify(receipt),destination=`${base}/${resolvedTableId??('table_name' in resolvedDefaultTarget?resolvedDefaultTarget.table_name:'unknown')}`;
  const savedReceipt=await (connectionHeld&&db?db:pool).query(`WITH saved AS (
   UPDATE ai_distill.step_attempts SET result=result||jsonb_build_object('feishu_sync',$2::jsonb,'feishu_deliveries',COALESCE(result->'feishu_deliveries','{}'::jsonb)||jsonb_build_object($5::text,$2::jsonb))
   WHERE workflow_id=$1 AND id=$4 AND ordinal=8 AND status='succeeded' AND result->>'source_digest'=$3
    AND id=(SELECT id FROM ai_distill.step_attempts WHERE workflow_id=$1 AND ordinal=8 ORDER BY attempt DESC LIMIT 1)
   RETURNING workflow_id
  ) UPDATE ai_distill.steps SET result=result||jsonb_build_object('feishu_sync',$2::jsonb,'feishu_deliveries',COALESCE(result->'feishu_deliveries','{}'::jsonb)||jsonb_build_object($5::text,$2::jsonb))
   WHERE workflow_id=$1 AND ordinal=8 AND status='succeeded' AND result->>'source_digest'=$3 AND EXISTS(SELECT 1 FROM saved)`,[workflowId,payload,archiveId,archiveAttemptId,destination]);
  if((receipt as {status?:string}).status==='succeeded'&&!savedReceipt.rowCount)throw new VerificationError('feishu_source_changed',['归档版本']);
 }
}
