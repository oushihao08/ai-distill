/**
 * 职责：统一的飞书多维表格题目交付共用模块，供工作流草稿/归档同步、批次调度、本地题包清单同步与各项目脚本复用。
 * 核心入口：
 *   1. `createFeishuDeliverySession()`：维护单个复用会话、表结构10分钟缓存与每表空行清理状态；
 *   2. `uploadFeishuAttachments()`：有界并发上传多份附件并严格保持原索引顺序；
 *   3. `deliverQuestionToFeishu()`：执行查重、按需惰性准备与上传附件、写入/修订记录及逐字符6字段+附件回读校验。
 * 安全边界：未知写入绝不自动换 client_token 重试；仅空字段补写题目ID，人工不同值视为冲突拒绝覆盖。
 */
import {canonicalJson} from '../../shared/workflow-config';
import {clearFeishuAuthTokenCache} from '../../toolSkills/feishu-operations/scripts/client';
import {feishuClient,SyncError,ensureFeishuSchema,createFeishuTable,removeEmptyFeishuRows,type FeishuSessionClient} from './feishu-api';
import {findFeishuWorkflowRecords} from './feishu-records';
import type {FeishuAttachmentFormat,FeishuTarget} from './feishu-targets';
import {feishuTextFields,compareFeishuText,hasFeishuAttachmentNames,VerificationError} from './feishu-verification';
import {isLegacyHashAttachmentList} from './material-pdf';

const FEISHU_SCHEMA_CACHE_TTL_MS=10*60_000;
const DEFAULT_UPLOAD_CONCURRENCY=4;
const verifiedFeishuSchemas=new Map<string,{verifiedAt:number;fieldNames:Set<string>}>();
const cleanedEmptyRowTables=new Set<string>();
const localTableWriteQueues=new Map<string,Promise<void>>();

export function clearFeishuDeliverySessionCache(){
 verifiedFeishuSchemas.clear();
 cleanedEmptyRowTables.clear();
 clearFeishuAuthTokenCache();
}

/** 进程内同表写操作排队，避免并发交付同时争抢数据库连接或飞书同表写锁；慢速PDF转换和素材上传不在此队列内。 */
async function withLocalTableWriteTurn<T>(tableKey:string,task:()=>Promise<T>):Promise<T>{
 const previous=localTableWriteQueues.get(tableKey)??Promise.resolve();
 let release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const current=previous.then(()=>gate);
 localTableWriteQueues.set(tableKey,current);
 await previous;
 try{return await task();}
 finally{
  release();
  if(localTableWriteQueues.get(tableKey)===current)localTableWriteQueues.delete(tableKey);
 }
}

export interface FeishuAttachmentPayload {
 name:string;
 bytes:Uint8Array;
 mimeType:string;
}

export interface PreparedFeishuAttachments {
 currentNames:string[];
 payloads:FeishuAttachmentPayload[];
 forceReplaceUpload?:boolean;
 isUpgradeableAttachmentFormat:(filesField:unknown)=>boolean;
}

export interface FeishuAttachmentProvider {
 /** 若无需执行PDF转换即可确知当前交付附件名列表（如DOCX或命中PDF缓存），提前传入以便远端已一致时直接跳过转换与上传。 */
 knownCurrentNames?:string[];
 knownUpgradeableAttachmentFormat?:(filesField:unknown)=>boolean;
 prepare:()=>Promise<PreparedFeishuAttachments>;
}

export interface FeishuDeliverySession {
 readonly api:FeishuSessionClient;
 ensureTableSchema(base:string,tableId:string):Promise<Set<string>>;
 ensureEmptyRowsCleaned(base:string,tableId:string,storageRoot:string):Promise<void>;
 close():Promise<void>;
}

export async function createFeishuDeliverySession(options:{timeoutMs?:number;clientFactory?:typeof feishuClient}={}):Promise<FeishuDeliverySession>{
 const openClient=options.clientFactory??feishuClient;
 const api=await openClient({timeoutMs:options.timeoutMs??180_000});
 return{
  api,
  async ensureTableSchema(base:string,tableId:string){
   const tableKey=`${base}/${tableId}`;
   const cached=verifiedFeishuSchemas.get(tableKey);
   if(cached!==undefined&&Date.now()-cached.verifiedAt<FEISHU_SCHEMA_CACHE_TTL_MS)return cached.fieldNames;
   try{
    const ensured=await ensureFeishuSchema(api,base,tableId);
    const fieldNames=ensured instanceof Set?ensured:new Set<string>();
    verifiedFeishuSchemas.set(tableKey,{verifiedAt:Date.now(),fieldNames});
    return fieldNames;
   }catch(error){
    verifiedFeishuSchemas.delete(tableKey);
    throw error;
   }
  },
  async ensureEmptyRowsCleaned(base:string,tableId:string,storageRoot:string){
   const tableKey=`${base}/${tableId}`;
   if(cleanedEmptyRowTables.has(tableKey))return;
   await removeEmptyFeishuRows(api,base,tableId,storageRoot);
   cleanedEmptyRowTables.add(tableKey);
  },
  async close(){await api.close();}
 };
}

/** 有界并发上传附件，严格按原数组下标写回 file_token，杜绝乱序且无需每份文件重启客户端。 */
export async function uploadFeishuAttachments(
 api:Pick<FeishuSessionClient,'call'>,
 baseToken:string,
 payloads:ReadonlyArray<FeishuAttachmentPayload>,
 options:{concurrency?:number;signal?:AbortSignal}={}
):Promise<Array<{file_token:string}>>{
 if(!payloads.length)return[];
 const limit=Math.max(1,Math.min(options.concurrency??DEFAULT_UPLOAD_CONCURRENCY,payloads.length));
 const results=new Array<{file_token:string}>(payloads.length);
 let cursor=0;
 const worker=async()=>{
  while(true){
   options.signal?.throwIfAborted();
   const index=cursor++;
   if(index>=payloads.length)return;
   const item=payloads[index]!;
   const form=new FormData();
   form.set('file_name',item.name);
   form.set('parent_type','bitable_file');
   form.set('parent_node',baseToken);
   form.set('size',String(item.bytes.byteLength));
   form.set('file',new Blob([new Uint8Array(item.bytes)],{type:item.mimeType}),item.name);
   const uploaded=await api.call('/drive/v1/medias/upload_all','POST',form);
   if(typeof uploaded?.file_token!=='string')throw new SyncError('feishu_upload_missing_token');
   results[index]={file_token:uploaded.file_token};
  }
 };
 await Promise.all(Array.from({length:limit},()=>worker()));
 return results;
}

export function hasExactAttachmentNames(value:unknown,names:ReadonlyArray<string>):boolean{
 if(names.length===0)return value===undefined||value===null||(Array.isArray(value)&&value.length===0);
 return hasFeishuAttachmentNames(value,names);
}

export interface FeishuWriteLockContext {
 assertCurrent?:()=>Promise<void>;
 previousSucceededReceipt?:{status?:string;base_token?:string;table_id?:string;[key:string]:unknown};
 resolveExtraExpectedFields?:(tableFieldNames:Set<string>)=>Promise<Record<string,string>>;
 saveReceipt?:(receipt:Record<string,unknown>)=>Promise<void>;
}

export interface DeliverQuestionToFeishuOptions {
 workflowId:string;
 question:any;
 stage:'draft'|'archived';
 target:FeishuTarget|{base_token:string;table_name:string};
 attachmentFormat:FeishuAttachmentFormat;
 attachments:FeishuAttachmentProvider;
 sourceDigest?:string;
 storageRoot?:string;
 allowRecreateDeleted?:boolean;
 revisionAttemptId?:string;
 replaceRecordId?:string;
 authoringMaterialBinding?:{snapshot_digest?:unknown;materials?:unknown};
 uploadConcurrency?:number;
 signal?:AbortSignal;
 session?:FeishuDeliverySession;
 clientFactory?:typeof feishuClient;
 /** 当 target 仅给出 table_name 且远端不存在该表时的可选建表钩子（如持PG咨询锁建表）。 */
 createMissingTable?:(api:FeishuSessionClient,baseToken:string,tableName:string)=>Promise<string>;
 /** 可选写阶段临界区钩子（如PG事务锁+当前版本校验+持久化归档回执）；返回 {abortedResult} 时提前安全退出。 */
 withWriteCriticalSection?:<T>(
  resolvedTarget:FeishuTarget,
  tableFieldNames:Set<string>,
  run:(ctx:FeishuWriteLockContext)=>Promise<T>
 )=>Promise<{kind:'completed';value:T}|{kind:'aborted';receipt:Record<string,unknown>}>;
 onProgressOperation?:(operation:string)=>Promise<void>|void;
}

/**
 * 飞书单题交付共用核心函数：
 * 1. 表定位与表结构缓存核验（必要时清理空行）；
 * 2. 写锁外预查远端同 workflowId 记录：若远端已存在且附件名已匹配，跳过耗时的PDF栅格化与媒体上传；
 * 3. 需要上传时在写锁外完成附件构建与有界并发上传；
 * 4. 进入同表写队列与可选数据库临界区，复核记录、执行创建/更新/修订并逐字符回读验证6项正文与附件token。
 */
export async function deliverQuestionToFeishu(options:DeliverQuestionToFeishuOptions):Promise<Record<string,any>>{
 const workflowId=options.workflowId.toLowerCase();
 const {question,stage,attachmentFormat,replaceRecordId,revisionAttemptId}=options;
 const base=options.target.base_token;
 let tableId='table_id' in options.target?options.target.table_id:undefined;
 const ownsSession=!options.session;
 const session=options.session??await createFeishuDeliverySession({clientFactory:options.clientFactory});
 const api=session.api;
 let verification:Record<string,any>={status:'incomplete',checked_at:new Date().toISOString()};
 try{
  if(!tableId){
   const phase=('table_name' in options.target?options.target.table_name:'').trim();
   if(!phase)throw new SyncError('feishu_phase_missing');
   const tables=await api.list(`/bitable/v1/apps/${base}/tables`);
   const matches=tables.filter(x=>x.name===phase);
   if(matches.length>1)throw new SyncError('feishu_duplicate_phase_tables');
   tableId=matches[0]?.table_id;
   if(!tableId){
    if(options.createMissingTable){
     tableId=await options.createMissingTable(api,base,phase);
    }else{
     tableId=(await createFeishuTable(api,base,phase)).table_id;
    }
    verifiedFeishuSchemas.set(`${base}/${tableId}`,{verifiedAt:Date.now(),fieldNames:new Set()});
   }
  }
  if(typeof tableId!=='string')throw new SyncError('feishu_table_missing');
  const resolvedTarget:FeishuTarget={base_token:base,table_id:tableId};
  const tableKey=`${base}/${tableId}`;
  const path=`/bitable/v1/apps/${base}/tables/${tableId}`;

  await options.onProgressOperation?.('schema');
  const tableFieldNames=await session.ensureTableSchema(base,tableId);
  if(stage==='archived'&&options.storageRoot){
   await session.ensureEmptyRowsCleaned(base,tableId,options.storageRoot);
  }

  await options.onProgressOperation?.('identity_lookup');
  const preLookup=await findFeishuWorkflowRecords(api,path,workflowId);
  if(preLookup.length>1)throw new VerificationError('feishu_duplicate_question_records',['题目ID重复']);
  const preExisting=preLookup[0];

  let prepared:PreparedFeishuAttachments|undefined;
  const ensurePrepared=async()=>{
   if(!prepared){
    prepared=await options.attachments.prepare();
    verification.materials='passed';
   }
   return prepared;
  };

  // 若调用方已提供确定性的附件名（如DOCX或命中本地PDF分册缓存），且远端已有同名附件且非强制替换/改名修订，无需预转换PDF或预上传。
  const forceUploadRequested=Boolean((replaceRecordId&&preExisting?.record_id===replaceRecordId)||(revisionAttemptId&&question?.manual_revision?.kind==='subject_names'));
  const knownNames=options.attachments.knownCurrentNames;
  const preExistingMatchesKnown=Boolean(preExisting&&!forceUploadRequested&&knownNames&&hasExactAttachmentNames(preExisting.fields?.['输入附件'],knownNames));
  if(!preExistingMatchesKnown){
   await ensurePrepared();
  }else{
   verification.materials='passed';
  }

  const needsAttachmentUpgrade=(fields:Record<string,unknown>|undefined,spec:PreparedFeishuAttachments)=>{
   if(!fields)return false;
   const filesField=fields['输入附件'];
   if(hasExactAttachmentNames(filesField,spec.currentNames))return false;
   return spec.isUpgradeableAttachmentFormat(filesField);
  };

  let preUploaded:{file_token:string}[]|undefined;
  if(!preExistingMatchesKnown){
   const spec=await ensurePrepared();
   const shouldPreUpload=!preExisting||forceUploadRequested||needsAttachmentUpgrade(preExisting.fields,spec);
   if(shouldPreUpload){
    await options.onProgressOperation?.('attachment_upload');
    preUploaded=await uploadFeishuAttachments(api,base,spec.payloads,{concurrency:options.uploadConcurrency,signal:options.signal});
   }
  }
  const obtainAttachments=async()=>{
   if(preUploaded){const ready=preUploaded;preUploaded=undefined;return ready;}
   const spec=await ensurePrepared();
   await options.onProgressOperation?.('attachment_upload');
   return uploadFeishuAttachments(api,base,spec.payloads,{concurrency:options.uploadConcurrency,signal:options.signal});
  };

  const executeWriteSection=async(ctx:FeishuWriteLockContext):Promise<Record<string,any>>=>{
   const assertCurrent=async()=>{if(ctx.assertCurrent)await ctx.assertCurrent();};
   await assertCurrent();
   const matches=await findFeishuWorkflowRecords(api,path,workflowId);
   if(matches.length>1)throw new VerificationError('feishu_duplicate_question_records',['题目ID重复']);
   const existing=matches[0];
   const existingCompletion=existing?.fields?.['题目是否完成'];
   if(replaceRecordId&&(stage!=='draft'||revisionAttemptId||!existing||existing.record_id!==replaceRecordId||(existing.fields?.['系统同步ID']&&existing.fields['系统同步ID']!==workflowId)||existing.fields?.['题目ID']!==workflowId||!['未完成','已完成'].includes(existingCompletion))){
    throw new VerificationError('feishu_replace_identity_mismatch',['题目ID','系统同步ID','题目是否完成']);
   }
   const completionStatus=replaceRecordId?existingCompletion:stage==='draft'?'未完成':'已完成';
   const expected=feishuTextFields(workflowId,question,completionStatus);
   if(ctx.resolveExtraExpectedFields){
    Object.assign(expected,await ctx.resolveExtraExpectedFields(tableFieldNames));
   }
   const legacyExpected=feishuTextFields(workflowId,question,stage==='draft'?'未完成':'已完成','legacy');
   if(existing&&!revisionAttemptId&&existing.fields?.['考点rubric']===legacyExpected['考点rubric']){
    expected['考点rubric']=legacyExpected['考点rubric']!;
   }

   const currentNames=()=>prepared?.currentNames??knownNames!;
   const isUpgradeable=(filesField:unknown)=>prepared?prepared.isUpgradeableAttachmentFormat(filesField):(options.attachments.knownUpgradeableAttachmentFormat?.(filesField)??false);

   const verify=async(recordId:string,uploadedTokens?:string[])=>{
    await options.onProgressOperation?.('record_readback');
    let readback=await api.call(path+'/records/'+recordId),actual=readback.record?.fields??{};
    const compare=()=>{
     const names=currentNames();
     const differences=compareFeishuText(expected,actual),remoteFiles=actual['输入附件'];
     const normalizedRemote=Array.isArray(remoteFiles)?remoteFiles:(remoteFiles===undefined||remoteFiles===null?[]:null);
     if(!normalizedRemote||normalizedRemote.length!==names.length||normalizedRemote.some((file:any,index:number)=>uploadedTokens?file.file_token!==uploadedTokens[index]:file.name!==names[index])){
      differences.push({field:'输入附件',expected_length:names.length,actual_length:normalizedRemote?normalizedRemote.length:null,first_difference:0});
     }
     return differences;
    };
    let differences=compare();
    const canUpgradeStatus=stage==='archived'&&actual['题目是否完成']==='未完成';
    const canSwitchFormat=!uploadedTokens&&!hasExactAttachmentNames(actual['输入附件'],currentNames())&&isUpgradeable(actual['输入附件']);
    if(differences.length&&(canUpgradeStatus||canSwitchFormat)&&!differences.some((difference:any)=>!(canUpgradeStatus&&difference.field==='题目是否完成')&&!(canSwitchFormat&&difference.field==='输入附件'))){
     const updates:Record<string,unknown>={};
     if(canUpgradeStatus&&actual['题目是否完成']==='未完成')updates['题目是否完成']='已完成';
     let switchedTokens:string[]|undefined;
     if(canSwitchFormat){
      const spec=await ensurePrepared();
      if(!hasExactAttachmentNames(actual['输入附件'],spec.currentNames)){
       const uploaded=await obtainAttachments();
       updates['输入附件']=uploaded;
       switchedTokens=uploaded.map(item=>item.file_token);
      }
     }
     if(Object.keys(updates).length){
      await assertCurrent();
      await api.call(path+'/records/'+recordId,'PUT',{fields:updates});
      readback=await api.call(path+'/records/'+recordId);actual=readback.record?.fields??{};
      if(switchedTokens)uploadedTokens=switchedTokens;
      differences=compare();
     }
    }
    await assertCurrent();
    verification={...verification,status:differences.length?'failed':'passed',checked_at:new Date().toISOString(),question_version:question.question_version,rubric_version:question.rubric_version,differences};
    if(differences.length)throw new VerificationError('feishu_record_readback_mismatch',differences.map(x=>x.field));
   };

   let revisionUploadedTokens:string[]|undefined;
   if(existing&&replaceRecordId){
    const spec=await ensurePrepared();
    const before=existing.fields??{};
    if((before['系统同步ID']&&before['系统同步ID']!==workflowId)||before['题目ID']!==workflowId||before['题目是否完成']!==completionStatus){
     throw new VerificationError('feishu_replace_identity_mismatch',['题目ID','系统同步ID','题目是否完成']);
    }
    const changed=compareFeishuText(expected,before).length>0||!hasExactAttachmentNames(before['输入附件'],spec.currentNames)||Boolean(spec.forceReplaceUpload)||Boolean(replaceRecordId);
    if(changed){
     const uploaded=await obtainAttachments();
     const fields:Record<string,unknown>={};
     if(!before['系统同步ID'])fields['系统同步ID']=workflowId;
     for(const key of ['任务名称','任务类型','prompt','考点rubric','作答思路','标准答案-文本'])if(before[key]!==expected[key])fields[key]=expected[key];
     fields['输入附件']=uploaded;
     await assertCurrent();
     await options.onProgressOperation?.('record_write');
     await api.call(path+'/records/'+replaceRecordId,'PUT',{fields});
     const after=(await api.call(path+'/records/'+replaceRecordId)).record?.fields??{};
     for(const key of new Set([...Object.keys(before),...Object.keys(after)])){
      if(!(key in fields)&&canonicalJson(before[key]??null)!==canonicalJson(after[key]??null))throw new VerificationError('feishu_unrelated_field_changed',[key]);
     }
     revisionUploadedTokens=uploaded.map(item=>item.file_token);
    }
   }

   if(existing&&revisionAttemptId){
    const spec=await ensurePrepared();
    const revision=question.manual_revision;
    if(stage!=='draft'||revision?.attempt_id!==revisionAttemptId)throw new VerificationError('feishu_revision_mismatch',['题目版本']);
    const actual=existing.fields??{};
    const beforeQuestion=revision.kind==='subject_names'
     ?revision.before?.question??revision.before
     :{...question,...(revision.before&&typeof revision.before==='object'?revision.before:{question:revision.before})};
    const afterQuestion=revision.after?.question;
    if(revision.kind==='subject_names'){
     if(!beforeQuestion||!afterQuestion||!revision.before?.material_binding||!revision.after?.material_binding){
      throw new VerificationError('feishu_revision_binding_missing',['题目版本','材料来源']);
     }
     if(options.authoringMaterialBinding&&(canonicalJson(options.authoringMaterialBinding)!==canonicalJson(revision.after.material_binding)||canonicalJson(feishuTextFields(workflowId,afterQuestion,'未完成'))!==canonicalJson(expected))){
      throw new VerificationError('feishu_revision_mismatch',['题目版本','材料来源']);
     }
    }
    const currentDifferences=compareFeishuText(expected,actual),currentAttachments=hasExactAttachmentNames(actual['输入附件'],spec.currentNames);
    if(currentDifferences.length||!currentAttachments){
     const recordedStatus=revision.before?.completion_status==='已完成'?'已完成':'未完成';
     const priorComparisons=[recordedStatus,recordedStatus==='已完成'?'未完成':'已完成'].flatMap(status=>(['numbered','legacy'] as const).map(layout=>compareFeishuText(feishuTextFields(workflowId,beforeQuestion,status as '已完成'|'未完成',layout),actual)));
     const differences=priorComparisons.find(items=>items.length===0)??priorComparisons[0]!;
     const previousAttachmentNames=revision.before?.attachment_names;
     const previousAttachmentAlts=Array.isArray(previousAttachmentNames)?previousAttachmentNames.map((name:unknown)=>typeof name==='string'?name.replace(/\.docx$/i,'.pdf'):''):[];
     const subjectNameRevision=revision.kind==='subject_names';
     const previousAttachmentsMatch=(Array.isArray(previousAttachmentNames)&&previousAttachmentNames.length>0&&(hasExactAttachmentNames(actual['输入附件'],previousAttachmentNames)||hasExactAttachmentNames(actual['输入附件'],previousAttachmentAlts)))||isLegacyHashAttachmentList(actual['输入附件']);
     if(differences.length||(subjectNameRevision?!previousAttachmentsMatch:!currentAttachments)){
      throw new VerificationError('feishu_revision_old_value_conflict',[...differences.map((d:any)=>d.field),...((subjectNameRevision?previousAttachmentsMatch:currentAttachments)?[]:['输入附件'])]);
     }
     const mutableFields=['任务名称','任务类型','prompt','考点rubric','作答思路','标准答案-文本','题目是否完成'];
     const fields:Record<string,unknown>=Object.fromEntries(mutableFields.filter(key=>actual[key]!==expected[key]).map(key=>[key,expected[key]]));
     if(subjectNameRevision){const uploaded=await obtainAttachments();fields['输入附件']=uploaded;revisionUploadedTokens=uploaded.map(item=>item.file_token);}
     await assertCurrent();
     await options.onProgressOperation?.('record_write');
     await api.call(path+'/records/'+existing.record_id,'PUT',{fields});
     const after=(await api.call(path+'/records/'+existing.record_id)).record?.fields??{},allowed=new Set(Object.keys(fields));
     for(const key of new Set([...Object.keys(actual),...Object.keys(after)])){
      if(!allowed.has(key)&&canonicalJson(actual[key]??null)!==canonicalJson(after[key]??null))throw new VerificationError('feishu_unrelated_field_changed',[key]);
     }
    }
   }

   if(existing){
    const patchFields:Record<string,string>={};
    if(!existing.fields?.['题目ID'])patchFields['题目ID']=workflowId;
    if(expected['旧题目ID']&&!existing.fields?.['旧题目ID'])patchFields['旧题目ID']=expected['旧题目ID'];
    if(expected['旧任务名称']&&!existing.fields?.['旧任务名称'])patchFields['旧任务名称']=expected['旧任务名称'];
    if(Object.keys(patchFields).length){
     await options.onProgressOperation?.('record_write');
     await api.call(path+'/records/'+existing.record_id,'PUT',{fields:patchFields});
    }
    await verify(existing.record_id,revisionUploadedTokens);
    const receipt={status:'succeeded',stage,attachment_format:attachmentFormat,table_id:tableId,record_id:existing.record_id,...(options.sourceDigest?{source_digest:options.sourceDigest}:{}),base_token:base,url:`https://ncn9ze979yuh.feishu.cn/base/${base}?table=${tableId}`,synced_at:new Date().toISOString(),reused:true,verification};
    if(ctx.saveReceipt)await ctx.saveReceipt(receipt);
    return receipt;
   }

   const previousReceipt=ctx.previousSucceededReceipt;
   if(previousReceipt?.status==='succeeded'&&previousReceipt.base_token===base&&previousReceipt.table_id===tableId&&!options.allowRecreateDeleted){
    return{...previousReceipt,status:'remote_deleted',reason_code:'feishu_record_deleted'};
   }

   await ensurePrepared();
   const attachments=await obtainAttachments();
   const body={fields:{...expected,...(attachments.length?{'输入附件':attachments}:{})}};
   await assertCurrent();
   const createClientToken=crypto.randomUUID();
   await options.onProgressOperation?.('record_write');
   const result=await api.call(path+`/records?client_token=${createClientToken}`,'POST',body);
   const recordId=result.record?.record_id;
   if(typeof recordId!=='string')throw new SyncError('feishu_record_id_missing');
   await verify(recordId,attachments.map(item=>item.file_token));
   const receipt={status:'succeeded',stage,attachment_format:attachmentFormat,table_id:tableId,record_id:recordId,verification,create_client_token:createClientToken,...(options.sourceDigest?{source_digest:options.sourceDigest}:{}),base_token:base,url:`https://ncn9ze979yuh.feishu.cn/base/${base}?table=${tableId}`,synced_at:new Date().toISOString()};
   if(ctx.saveReceipt)await ctx.saveReceipt(receipt);
   return receipt;
  };

  return await withLocalTableWriteTurn(tableKey,async()=>{
   if(!options.withWriteCriticalSection){
    return executeWriteSection({});
   }
   const wrapped=await options.withWriteCriticalSection(resolvedTarget,tableFieldNames,executeWriteSection);
   return wrapped.kind==='aborted'?wrapped.receipt:wrapped.value;
  });
 }catch(error){
  if(error instanceof VerificationError){
   verification={...verification,status:'failed',reason_code:error.code,fields:error.fields};
  }
  throw Object.assign(error instanceof Error?error:new SyncError('feishu_request_failed'),{
   feishu_verification:verification,
   feishu_resolved_table_id:tableId,
   feishu_base_token:base,
  });
 }finally{
  if(ownsSession)await session.close();
 }
}
