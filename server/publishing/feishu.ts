/**
 * 职责：豆包题目的飞书草稿上传及达标归档后交付；上传当前冻结材料DOCX或经docx-to-image-pdf.py转换的图像PDF并更新同一目标表内的题目记录。
 * 入口：syncAuthoredWorkflowToFeishu()供显式草稿上传，syncArchivedWorkflowToFeishu()供归档worker与显式补传；失败不改写出题/归档状态。
 * 边界：只启用豆包法律与医疗两个主项目，期次目标按主项目分别冻结；凭证仅从服务端环境读取，远端响应正文不进入公开错误或日志。
 */
import type {Pool} from 'pg';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HTTPException} from 'hono/http-exception';
import {exportCurrentMaterialDocx,readCurrentMaterialDocx,readCurrentRedactionForDocx} from '../materials/redacted-docx-export';
import {logEvent} from '../logging';
import {canonicalJson} from '../../shared/workflow-config';
import {isEvaluationPipelineSealed} from '../../shared/step-registry';
import {findFeishuWorkflowRecords} from './feishu-records';
import {feishuTextFields,compareFeishuText,VerificationError} from './feishu-verification';

import {feishuClient,SyncError,ensureFeishuSchema,createFeishuTable,removeEmptyFeishuRows} from './feishu-api';
import {readFeishuDeliveryConfig,validateFeishuTarget,type FeishuTarget,type FeishuAttachmentFormat} from './feishu-targets';

import {materialPdfAttachments,materialPdfBaseNames,materialCleanPdfBaseNames,isLegacyHashAttachmentList,COMBINED_MATERIAL_PDF_STEM} from './material-pdf';

const DOUBAO_LEGAL_GROUP='315407cd-43db-49d1-8eb3-c2dff77af859';
const DOUBAO_REVISION_GROUP='95e1e1d7-a567-4d48-90a6-3191821d93d6';
const FEISHU_SCHEMA_CACHE_TTL_MS=10*60_000;
const verifiedFeishuSchemas=new Map<string,{verifiedAt:number;fieldNames:Set<string>}>();
const cleanedEmptyRowTables=new Set<string>();
export function clearFeishuDeliverySessionCache(){verifiedFeishuSchemas.clear();cleanedEmptyRowTables.clear();}

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
export async function syncArchivedWorkflowToFeishu(pool:Pool,workflowId:string,storageRoot:string,assetRoot:string,targetOverride?:FeishuTarget,allowRecreateDeleted=false,attachmentFormatOverride?:FeishuAttachmentFormat,combinedMaterial=false,expectedAuthor?:string){
 return syncWorkflowToFeishu(pool,workflowId,storageRoot,assetRoot,'archived',targetOverride,allowRecreateDeleted,undefined,attachmentFormatOverride,combinedMaterial,undefined,expectedAuthor);
}

/** 显式上传当前出题结果为未完成草稿；不要求达标/归档，也不更改工作流步骤。 */
export async function syncAuthoredWorkflowToFeishu(pool:Pool,workflowId:string,storageRoot:string,assetRoot:string,targetOverride?:FeishuTarget,revisionAttemptId?:string,attachmentFormatOverride?:FeishuAttachmentFormat,combinedMaterial=false,replaceRecordId?:string,expectedAuthor?:string){
 return syncWorkflowToFeishu(pool,workflowId,storageRoot,assetRoot,'draft',targetOverride,false,revisionAttemptId,attachmentFormatOverride,combinedMaterial,replaceRecordId,expectedAuthor);
}

async function syncWorkflowToFeishu(pool:Pool,workflowId:string,storageRoot:string,assetRoot:string,stage:'draft'|'archived',targetOverride?:FeishuTarget,allowRecreateDeleted=false,revisionAttemptId?:string,attachmentFormatOverride?:FeishuAttachmentFormat,combinedMaterial=false,replaceRecordId?:string,expectedAuthor?:string){
 workflowId=workflowId.toLowerCase();
 // 跨数据库校验、远端分页和附件上传；子进程预算均须覆盖整段会话。
 const openFeishuClient=()=>feishuClient({timeoutMs:600_000});
 const context=(await pool.query(`SELECT w.project_id,p.project_group_id,p.phase_name FROM ai_distill.workflows w JOIN ai_distill.projects p ON p.id=w.project_id WHERE w.id=$1 AND w.deleted_at IS NULL AND p.deleted_at IS NULL`,[workflowId])).rows[0];
 if(!context)return{status:'not_applicable'};
 const settings=await readFeishuDeliveryConfig(pool,String(context.project_id));
 if(!settings)return{status:'not_applicable'};
 const target=targetOverride?validateFeishuTarget(targetOverride):settings.default_target;
 const attachmentFormat:FeishuAttachmentFormat=attachmentFormatOverride??settings.attachment_format??'docx';
  // 法律与返修主项目的飞书交付一题一份合册：PDF为“案卷材料.pdf”（超15MB按页分为第一册、第二册），显式DOCX仍为材料.docx；按冻结文书顺序拼接。
  combinedMaterial=combinedMaterial||String(context.project_group_id)===DOUBAO_LEGAL_GROUP||String(context.project_group_id)===DOUBAO_REVISION_GROUP;
 const base=target.base_token;
 let tableId='table_id' in target?target.table_id:undefined;
 const sealed=isEvaluationPipelineSealed();
 let db=await pool.connect(),connectionHeld=true;let transaction=false,archiveId:string|undefined,archiveAttemptId:string|undefined;
 let verification:any={status:'incomplete',checked_at:new Date().toISOString()};
 let api:Awaited<ReturnType<typeof feishuClient>>|undefined;
 try{
  // 分开读取步骤与本题版本匹配的attempt，避免相关子查询反复解读外层JSON。
  const snapshot=async()=>{
   const row=stage==='archived'
    ?(await db.query(sealed
     ?`SELECT q.result AS question,a.result AS acceptance,r.result AS archive
       FROM ai_distill.steps q LEFT JOIN ai_distill.steps a ON a.workflow_id=q.workflow_id AND a.ordinal=7 AND a.status='succeeded' AND a.result->>'decision'='accepted'
       JOIN ai_distill.steps r ON r.workflow_id=q.workflow_id AND r.ordinal=8
       WHERE q.workflow_id=$1 AND q.ordinal=4 AND q.status='succeeded' AND r.status='succeeded'`
     :`SELECT q.result AS question,a.result AS acceptance,r.result AS archive
       FROM ai_distill.steps q JOIN ai_distill.steps a ON a.workflow_id=q.workflow_id AND a.ordinal=7
       JOIN ai_distill.steps r ON r.workflow_id=q.workflow_id AND r.ordinal=8
       WHERE q.workflow_id=$1 AND q.ordinal=4 AND q.status='succeeded' AND a.status='succeeded'
        AND a.result->>'decision'='accepted' AND r.status='succeeded'`,[workflowId])).rows[0]
    :(await db.query(`SELECT q.result AS question FROM ai_distill.steps q JOIN ai_distill.workflows w ON w.id=q.workflow_id
      WHERE q.workflow_id=$1 AND q.ordinal=4 AND q.status='succeeded' AND w.workflow_kind='question'
       AND NOT EXISTS(SELECT 1 FROM ai_distill.steps archived WHERE archived.workflow_id=$1 AND archived.ordinal=8 AND archived.status='succeeded')`,[workflowId])).rows[0];
   if(!row)return;
   const author=(await db.query(`SELECT id,jsonb_build_object('materials',input->'materials','material_origin',input->'material_origin',
     'redaction_attempt_id',input->'redaction_attempt_id') AS input,
     encode(sha256(convert_to(input::text,'UTF8')),'hex') AS input_digest FROM ai_distill.step_attempts
    WHERE workflow_id=$1 AND ordinal=4 AND status='succeeded' AND result->>'question_version'=$2
     AND result->>'rubric_version'=$3 ORDER BY attempt DESC LIMIT 1`,[workflowId,row.question?.question_version,row.question?.rubric_version])).rows[0];
   const archive=stage==='archived'?(await db.query(`SELECT id FROM ai_distill.step_attempts
    WHERE workflow_id=$1 AND ordinal=8 AND status='succeeded' ORDER BY attempt DESC LIMIT 1`,[workflowId])).rows[0]:undefined;
   return{...row,authoring_input:author?.input,authoring_input_digest:author?.input_digest,authoring_attempt_id:author?.id,archive_attempt_id:archive?.id};
  };
  const snapshotKey=(value:any)=>stage==='archived'?value?.archive?.source_digest:createHash('sha256').update(canonicalJson({question_version:value?.question?.question_version,rubric_version:value?.question?.rubric_version,authoring_input_digest:value?.authoring_input_digest})).digest('hex');
  const initial=await snapshot();
  if(expectedAuthor&&initial?.authoring_attempt_id!==expectedAuthor)throw new SyncError('feishu_authoring_version_changed');
  if(!initial||!initial.question||!initial.authoring_input||!initial.question.question_version||!initial.question.rubric_version)throw new SyncError(stage==='archived'?'feishu_current_archive_required':'feishu_current_authoring_required');
  if(stage==='archived'&&(initial.archive.question_version!==initial.question.question_version||initial.archive.rubric_version!==initial.question.rubric_version))throw new SyncError('feishu_current_archive_required');
  // 草稿用出题版本和冻结输入生成本地比较键；正式交付仍使用归档摘要与attempt身份。
  archiveId=snapshotKey(initial);archiveAttemptId=initial.archive_attempt_id;
  // 冻结输入仅投影材料绑定字段；SHA-256覆盖完整JSON，避免重复传输大体积任务输入。
  // 后续比较完整题目、完整输入摘要及当前匹配attempt，不只相信版本号。
  const assertCurrent=async()=>{
   const current=(await db.query(`SELECT q.result=$2::jsonb
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

  // 生成器自行管理事务；先归还连接再导出，避免占满池后等待第二条连接。
  db.release();connectionHeld=false;
  if(!initial.authoring_input)throw new VerificationError('feishu_authoring_materials_missing',['材料来源']);
  // 以本次有效出题attempt的冻结输入校验材料来源；法律主项目飞书DOCX合册，其余布局沿用导出器规则。
  // 合册保留原卷文书顺序和边界，附件名不使用内部摘要。
  let exported:Awaited<ReturnType<typeof exportCurrentMaterialDocx>>;
  try{exported=await exportCurrentMaterialDocx(pool,workflowId,storageRoot,assetRoot,undefined,{expectedAuthoringInput:initial.authoring_input,...(combinedMaterial?{deliveryLayout:'combined' as const}:{})});}
  catch(error){if(error instanceof HTTPException&&error.status===409)throw new VerificationError('feishu_material_validation_failed',['附件数量/大小/版本/SHA-256']);throw error;}
  verification.materials='passed';
  const files:NonNullable<Awaited<ReturnType<typeof readCurrentMaterialDocx>>>[]=[];
  const verifiedSource=await readCurrentRedactionForDocx(pool,workflowId);
  for(const artifact of exported.artifacts){
   const file=await readCurrentMaterialDocx(pool,artifact.artifact_id,assetRoot,{workflow_id:workflowId,source:verifiedSource});
   if(!file)throw new SyncError('feishu_attachment_missing');files.push(file);
  }
  if(combinedMaterial&&files.length!==1)throw new SyncError('feishu_combined_attachment_count');
  // 合册PDF使用固定业务文件名，避免导出器内部的“脱敏材料”名称进入交付。
  const pdfSourceFiles=combinedMaterial?files.map(file=>({...file,filename:`${COMBINED_MATERIAL_PDF_STEM}.docx`})):files;
  const pdfAttachments=attachmentFormat==='pdf'?await materialPdfAttachments(pdfSourceFiles,workflowId,storageRoot):undefined;
  const pdfStems=materialPdfBaseNames(files),cleanPdfStems=materialCleanPdfBaseNames(pdfSourceFiles),allPdfStems=[...new Set([...cleanPdfStems,...materialCleanPdfBaseNames(files),...pdfStems])],docxNames=combinedMaterial?['材料.docx']:pdfStems.map(stem=>`${stem}.docx`);
  const zippedDocx=!pdfAttachments&&files.length>100?await bundleDocxParts(files,docxNames):undefined;
  const currentAttachmentNames=zippedDocx?[zippedDocx.name]:pdfAttachments?pdfAttachments.map(file=>file.name):docxNames;
  const alternateAttachmentNames=attachmentFormat==='pdf'?docxNames:cleanPdfStems.map(stem=>`${stem}.pdf`);
  const hasAttachmentNames=(value:unknown,names:string[])=>Array.isArray(value)&&value.length===names.length&&value.every((file:any,index:number)=>file?.name===names[index]);
  const isCombinedDocxAttachment=(value:unknown)=>hasAttachmentNames(value,['材料.docx']);
  const matchesSplitPdfStems=(value:unknown)=>Array.isArray(value)&&value.length>0&&value.every((file:any)=>typeof file?.name==='string'&&allPdfStems.some(stem=>file.name===`${stem}.pdf`||(file.name.startsWith(`${stem}-页`)&&file.name.endsWith('.pdf'))||(file.name.startsWith(`${stem}（第`)&&file.name.endsWith('册）.pdf'))));

  api=await openFeishuClient();
  const remote={call:(path:string,method='GET',body?:unknown)=>api!.call(path,method,body)};
  const uploadCurrentAttachments=async()=>{
   const payloads=zippedDocx?[zippedDocx.bytes]:pdfAttachments?pdfAttachments.map(file=>file.bytes):files.map(file=>file.bytes);
   const mimeType=zippedDocx?'application/zip':attachmentFormat==='pdf'?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
   const attachments=[];
   let sessionStartedAt=0;
   for(const [index,payload] of payloads.entries()){
    if(!sessionStartedAt||Date.now()-sessionStartedAt>=45_000||payload.byteLength>=4_000_000){
     await api!.close();api=await openFeishuClient();sessionStartedAt=Date.now();
    }
    const filename=currentAttachmentNames[index]!;
    const form=new FormData();form.set('file_name',filename);form.set('parent_type','bitable_file');form.set('parent_node',base);form.set('size',String(payload.byteLength));form.set('file',new Blob([new Uint8Array(payload)],{type:mimeType}),filename);
    const uploaded=await api!.call('/drive/v1/medias/upload_all','POST',form);
    if(typeof uploaded.file_token!=='string')throw new SyncError('feishu_upload_missing_token');
    attachments.push({file_token:uploaded.file_token});
   }
   await api!.close();api=await openFeishuClient();
   return attachments;
  };
  const phase='table_name' in target?target.table_name:String(context.phase_name??'').trim();
  if(!tableId&&!phase)throw new SyncError('feishu_phase_missing');
  if(!tableId){
   const tables=await api.list(`/bitable/v1/apps/${base}/tables`);
   const matches=tables.filter(x=>x.name===phase);if(matches.length>1)throw new SyncError('feishu_duplicate_phase_tables');
   tableId=matches[0]?.table_id;
   if(!tableId){
    db=await pool.connect();connectionHeld=true;
    await db.query('BEGIN');transaction=true;
    const tableLock=(await db.query("SELECT pg_try_advisory_xact_lock(hashtext('feishu-base-v2'),hashtext($1)) AS locked",[base])).rows[0]?.locked===true;
    if(!tableLock)throw new SyncError('feishu_table_creation_busy');
    const fresh=(await api.list(`/bitable/v1/apps/${base}/tables`)).filter(x=>x.name===phase);
    if(fresh.length>1)throw new SyncError('feishu_duplicate_phase_tables');
    tableId=fresh[0]?.table_id;
    if(!tableId){
     tableId=(await createFeishuTable(api,base,phase)).table_id;
     verifiedFeishuSchemas.set(`${base}/${tableId}`,{verifiedAt:Date.now(),fieldNames:new Set()});
    }
    await db.query('COMMIT');transaction=false;db.release();connectionHeld=false;
   }
  }
  if(typeof tableId!=='string')throw new SyncError('feishu_table_missing');
  const tableKey=`${base}/${tableId}`;
  const path=`/bitable/v1/apps/${base}/tables/${tableId}`;
  const cachedSchema=verifiedFeishuSchemas.get(tableKey);
  let tableFieldNames:Set<string>;
  if(cachedSchema===undefined||Date.now()-cachedSchema.verifiedAt>=FEISHU_SCHEMA_CACHE_TTL_MS){
   try{
    const ensured=await ensureFeishuSchema(api,base,tableId);
    tableFieldNames=ensured instanceof Set?ensured:new Set<string>();
    verifiedFeishuSchemas.set(tableKey,{verifiedAt:Date.now(),fieldNames:tableFieldNames});
   }
   catch(error){verifiedFeishuSchemas.delete(tableKey);throw error;}
  }else{
   tableFieldNames=cachedSchema.fieldNames;
  }
  if(stage==='archived'&&!cleanedEmptyRowTables.has(tableKey)){
   await removeEmptyFeishuRows(api,base,tableId,storageRoot);
   cleanedEmptyRowTables.add(tableKey);
  }
  // 附件上传耗时较长，在获取数据库事务与整表写锁前提前查重并完成媒体上传，避免持锁等待网络IO。
  const preLookup=await findFeishuWorkflowRecords(api,path,workflowId);
  if(preLookup.length>1)throw new VerificationError('feishu_duplicate_question_records',['题目ID重复']);
  const preExisting=preLookup[0];
  const isUpgradeableAttachmentFormat=(filesField:unknown)=>hasAttachmentNames(filesField,alternateAttachmentNames)||(attachmentFormat==='pdf'&&(isCombinedDocxAttachment(filesField)||matchesSplitPdfStems(filesField)))||(attachmentFormat==='docx'&&matchesSplitPdfStems(filesField))||isLegacyHashAttachmentList(filesField);
  const needsAttachmentUpgrade=(fields:Record<string,unknown>|undefined)=>{
   if(!fields)return false;
   const filesField=fields['输入附件'];
   if(hasAttachmentNames(filesField,currentAttachmentNames))return false;
   return isUpgradeableAttachmentFormat(filesField);
  };
  const shouldPreUpload=!preExisting||(replaceRecordId&&preExisting.record_id===replaceRecordId)||(revisionAttemptId&&initial.question.manual_revision?.kind==='subject_names')||needsAttachmentUpgrade(preExisting.fields);
  let preUploaded:{file_token:string}[]|undefined=shouldPreUpload?await uploadCurrentAttachments():undefined;
  const obtainAttachments=async()=>{if(preUploaded){const ready=preUploaded;preUploaded=undefined;return ready;}return uploadCurrentAttachments();};

  db=await pool.connect();connectionHeld=true;
  // PgBouncer事务池不保证跨事务会话一致；锁必须位于同一显式事务中，并随事务结束释放。
  await db.query('BEGIN');transaction=true;
  // 兼容首次实测版残留的同题会话锁：仅在当前后端确实拥有该锁时释放，不触碰其他任务。
  await db.query("SELECT pg_advisory_unlock(hashtext('feishu-workflow'),hashtext($1))",[workflowId]);
  const locked=(await db.query("SELECT pg_try_advisory_xact_lock(hashtext('feishu-workflow-v2'),hashtext($1)) AS locked",[workflowId])).rows[0]?.locked===true;
  if(!locked)return{status:'in_progress'};

  await assertCurrent();
  // 先查远端稳定题目ID；请求幂等ID只属于一次创建，不承担题目身份。
  const previousReceipt=stage==='archived'?(initial.archive?.feishu_deliveries?.[`${base}/${tableId}`]??initial.archive?.feishu_sync):undefined;
  // 同表写入串行；仅校验与写记录阶段短时持有表锁。
  const tableWriteLock=(await db.query("SELECT pg_try_advisory_xact_lock(hashtext('feishu-table-write'),hashtext($1)) AS locked",[tableKey])).rows[0]?.locked===true;
  if(!tableWriteLock)return{status:'in_progress'};
  const matches=await findFeishuWorkflowRecords(api,path,workflowId);
  if(matches.length>1)throw new VerificationError('feishu_duplicate_question_records',['题目ID重复']);
  const existing=matches[0];
  const existingCompletion=existing?.fields?.['题目是否完成'];
  if(replaceRecordId&&(stage!=='draft'||revisionAttemptId||!existing||existing.record_id!==replaceRecordId||(existing.fields?.['系统同步ID']&&existing.fields['系统同步ID']!==workflowId)||existing.fields?.['题目ID']!==workflowId||!['未完成','已完成'].includes(existingCompletion)))throw new VerificationError('feishu_replace_identity_mismatch',['题目ID','系统同步ID','题目是否完成']);
  const completionStatus=replaceRecordId?existingCompletion:stage==='draft'?'未完成':'已完成';
  const expected=feishuTextFields(workflowId,initial.question,completionStatus);
  if(tableFieldNames.has('旧题目ID')||tableFieldNames.has('旧任务名称')){
   const origin=await readRevisionOrigin(db,workflowId);
   if(origin){
    if(tableFieldNames.has('旧题目ID'))expected['旧题目ID']=origin.orig_workflow_id;
    if(tableFieldNames.has('旧任务名称'))expected['旧任务名称']=origin.orig_task_name;
   }
  }
  // 普通重试保留已上传旧版编号，不因展示改版覆盖正文；仍逐字符验证同版全部字段。
  const legacyExpected=feishuTextFields(workflowId,initial.question,stage==='draft'?'未完成':'已完成','legacy');
  if(existing&&!revisionAttemptId&&existing.fields?.['考点rubric']===legacyExpected['考点rubric'])expected['考点rubric']=legacyExpected['考点rubric']!;
  // 新记录回读本次上传token；已有记录回读真实分件文件名、数量及顺序，并逐字符核对题目字段。
  // 当远端正文无差异且仅因docx/pdf格式切换、历史哈希附件升级或由草稿升为归档时，原地更新并回读新token。
  // 此处不下载飞书附件，故成功回执只证明记录字段和附件关联的回读结果。
  const verify=async(recordId:string,uploadedTokens?:string[])=>{
   let readback=await remote.call(path+'/records/'+recordId),actual=readback.record?.fields??{};
   const compare=()=>{
    const differences=compareFeishuText(expected,actual),remoteFiles=actual['输入附件'];
    if(!Array.isArray(remoteFiles)||remoteFiles.length!==currentAttachmentNames.length||remoteFiles.some((file:any,index:number)=>uploadedTokens?file.file_token!==uploadedTokens[index]:file.name!==currentAttachmentNames[index]))differences.push({field:'输入附件',expected_length:currentAttachmentNames.length,actual_length:Array.isArray(remoteFiles)?remoteFiles.length:null,first_difference:0});
    return differences;
   };
   let differences=compare();
   const canUpgradeStatus=stage==='archived'&&actual['题目是否完成']==='未完成';
   const canSwitchFormat=!uploadedTokens&&!hasAttachmentNames(actual['输入附件'],currentAttachmentNames)&&isUpgradeableAttachmentFormat(actual['输入附件']);
   if(differences.length&&(canUpgradeStatus||canSwitchFormat)&&!differences.some((difference:any)=>!(canUpgradeStatus&&difference.field==='题目是否完成')&&!(canSwitchFormat&&difference.field==='输入附件'))){
    const updates:Record<string,unknown>={};
    if(canUpgradeStatus&&actual['题目是否完成']==='未完成')updates['题目是否完成']='已完成';
    let switchedTokens:string[]|undefined;
    if(canSwitchFormat&&!hasAttachmentNames(actual['输入附件'],currentAttachmentNames)){
     const uploaded=await obtainAttachments();
     updates['输入附件']=uploaded;
     switchedTokens=uploaded.map(item=>item.file_token);
    }
    if(Object.keys(updates).length){
     await assertCurrent();await remote.call(path+'/records/'+recordId,'PUT',{fields:updates});
     readback=await remote.call(path+'/records/'+recordId);actual=readback.record?.fields??{};
     if(switchedTokens)uploadedTokens=switchedTokens;
     differences=compare();
    }
   }
   await assertCurrent();
   verification={...verification,status:differences.length?'failed':'passed',checked_at:new Date().toISOString(),question_version:initial.question.question_version,rubric_version:initial.question.rubric_version,differences};
   if(differences.length)throw new VerificationError('feishu_record_readback_mismatch',differences.map(x=>x.field));
  };
  let revisionUploadedTokens:string[]|undefined;
  if(existing&&replaceRecordId){
   const before=(await remote.call(path+'/records/'+replaceRecordId)).record?.fields??{};
   if((before['系统同步ID']&&before['系统同步ID']!==workflowId)||before['题目ID']!==workflowId||before['题目是否完成']!==completionStatus)throw new VerificationError('feishu_replace_identity_mismatch',['题目ID','系统同步ID','题目是否完成']);
   // 显式替换同时修正同名但内容错配的附件；仅比较文件名无法识别误传的材料.docx。
   const changed=compareFeishuText(expected,before).length>0||!hasAttachmentNames(before['输入附件'],currentAttachmentNames)||Boolean(zippedDocx)||Boolean(replaceRecordId);
   if(changed){
    const uploaded=await obtainAttachments();
    const fields:Record<string,unknown>={};
    if(!before['系统同步ID'])fields['系统同步ID']=workflowId;
    for(const key of ['任务名称','任务类型','prompt','考点rubric','作答思路','标准答案-文本'])if(before[key]!==expected[key])fields[key]=expected[key];
    fields['输入附件']=uploaded;
    await assertCurrent();
    await remote.call(path+'/records/'+replaceRecordId,'PUT',{fields});
    const after=(await remote.call(path+'/records/'+replaceRecordId)).record?.fields??{};
    for(const key of new Set([...Object.keys(before),...Object.keys(after)]))if(!(key in fields)&&canonicalJson(before[key]??null)!==canonicalJson(after[key]??null))throw new VerificationError('feishu_unrelated_field_changed',[key]);
    revisionUploadedTokens=uploaded.map(item=>item.file_token);
   }
  }
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
    const previousAttachmentAlts=Array.isArray(previousAttachmentNames)?previousAttachmentNames.map((name:unknown)=>typeof name==='string'?name.replace(/\.docx$/i,'.pdf'):''):[];
    const subjectNameRevision=revision.kind==='subject_names',previousAttachmentsMatch=(Array.isArray(previousAttachmentNames)&&previousAttachmentNames.length>0&&(hasAttachmentNames(actual['输入附件'],previousAttachmentNames)||hasAttachmentNames(actual['输入附件'],previousAttachmentAlts)))||isLegacyHashAttachmentList(actual['输入附件']);
    if(differences.length||(subjectNameRevision?!previousAttachmentsMatch:!currentAttachments))throw new VerificationError('feishu_revision_old_value_conflict',[...differences.map((d:any)=>d.field),...((subjectNameRevision?previousAttachmentsMatch:currentAttachments)?[]:['输入附件'])]);
    const mutableFields=['任务名称','任务类型','prompt','考点rubric','作答思路','标准答案-文本','题目是否完成'];
    const fields:Record<string,unknown>=Object.fromEntries(mutableFields.filter(key=>actual[key]!==expected[key]).map(key=>[key,expected[key]]));
    if(subjectNameRevision){const uploaded=await obtainAttachments();fields['输入附件']=uploaded;revisionUploadedTokens=uploaded.map(item=>item.file_token);}
    await assertCurrent();
    await remote.call(path+'/records/'+existing.record_id,'PUT',{fields});
    const after=(await remote.call(path+'/records/'+existing.record_id)).record?.fields??{},allowed=new Set(Object.keys(fields));
    for(const key of new Set([...Object.keys(actual),...Object.keys(after)]))if(!allowed.has(key)&&canonicalJson(actual[key]??null)!==canonicalJson(after[key]??null))throw new VerificationError('feishu_unrelated_field_changed',[key]);
   }
  }
  if(existing){
   // 兼容旧记录，仅补空白业务ID及返修关联字段；已有不同值属于冲突，不覆盖正文或人工ID。
   const patchFields:Record<string,string>={};
   if(!existing.fields?.['题目ID'])patchFields['题目ID']=workflowId;
   if(expected['旧题目ID']&&!existing.fields?.['旧题目ID'])patchFields['旧题目ID']=expected['旧题目ID'];
   if(expected['旧任务名称']&&!existing.fields?.['旧任务名称'])patchFields['旧任务名称']=expected['旧任务名称'];
   if(Object.keys(patchFields).length)await api.call(path+'/records/'+existing.record_id,'PUT',{fields:patchFields});
   await verify(existing.record_id,revisionUploadedTokens);
   const receipt={status:'succeeded',stage,attachment_format:attachmentFormat,table_id:tableId,record_id:existing.record_id,source_digest:archiveId,base_token:base,url:`https://ncn9ze979yuh.feishu.cn/base/${base}?table=${tableId}`,synced_at:new Date().toISOString(),reused:true,verification};
   if(stage==='archived')await save(receipt);await db.query('COMMIT');transaction=false;return receipt;
  }

  if(previousReceipt?.status==='succeeded'&&previousReceipt.base_token===base&&previousReceipt.table_id===tableId&&!allowRecreateDeleted)return{...previousReceipt,status:'remote_deleted',reason_code:'feishu_record_deleted'};

  const attachments=await obtainAttachments();
  const body={fields:{...expected,'输入附件':attachments}};
  await assertCurrent();
  // 一次创建只生成一个随机请求ID；不因失败自动换ID重发。
  const createClientToken=crypto.randomUUID();
  const result=await api.call(path+`/records?client_token=${createClientToken}`,'POST',body);
  const recordId=result.record?.record_id;
  if(typeof recordId!=='string')throw new SyncError('feishu_record_id_missing');
  await verify(recordId,attachments.map(item=>item.file_token));
  const receipt={status:'succeeded',stage,attachment_format:attachmentFormat,table_id:tableId,record_id:recordId,verification,create_client_token:createClientToken,source_digest:archiveId,base_token:base,url:`https://ncn9ze979yuh.feishu.cn/base/${base}?table=${tableId}`,synced_at:new Date().toISOString()};
  if(stage==='archived')await save(receipt);await db.query('COMMIT');transaction=false;return receipt;
 }catch(error){
  const reason=error instanceof SyncError||error instanceof VerificationError?error.code:'feishu_request_failed';
  if(error instanceof VerificationError)verification={...verification,status:'failed',reason_code:error.code,fields:error.fields};
  const receipt={status:'failed',stage,attachment_format:attachmentFormat,verification,workflow_id:workflowId,base_token:base,...(tableId?{table_id:tableId,url:`https://ncn9ze979yuh.feishu.cn/base/${base}?table=${tableId}`}:{ }),reason_code:reason,checked_at:new Date().toISOString()};
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

