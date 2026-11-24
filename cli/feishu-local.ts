/**
 * 职责：从显式本地题包清单交付飞书草稿，不请求业务API、不连接数据库。
 * 入口：syncLocalFeishu()供feishu local-sync调用；直接复用共用交付引擎 server/publishing/feishu-delivery.ts（单会话token/schema复用与并发媒体上传）。
 * 边界：仅上传清单快照为未完成草稿；进度文件保存回执，未知写入停止，不更新系统归档状态。
 */
import {readFile} from 'node:fs/promises';
import {basename,dirname,resolve,join} from 'node:path';
import {CliError} from './client';
import {atomicWriteJson,isUuid,sha256Hex,writeExclusiveJson} from './shared';
import type {FeishuCliTarget} from './feishu';
import {createFeishuDeliverySession,deliverQuestionToFeishu,hasExactAttachmentNames} from '../server/publishing/feishu-delivery';
import {VerificationError} from '../server/publishing/feishu-verification';
import {materialPdfAttachments,peekCachedMaterialPdfNames,materialPdfBaseNames,isLegacyHashAttachmentList} from '../server/publishing/material-pdf';
import {FeishuError} from '../toolSkills/feishu-operations/scripts/client';

export async function syncLocalFeishu(manifestPath:string,output:string,target:FeishuCliTarget,signal?:AbortSignal){
 const manifest=await readFile(resolve(manifestPath));
 const input=JSON.parse(manifest.toString('utf8'));
 if(input?.version!==1||!Array.isArray(input.items)||!input.items.length||input.items.length>1000)throw new CliError('本地清单须为version=1及1至1000项items');
 const ids=new Set<string>();
 const items=[];
 for(const item of input.items){
  if(!isUuid(item.workflow_id)||ids.has(item.workflow_id))throw new CliError('本地清单题目ID无效或重复');
  ids.add(item.workflow_id);
  if(!item.question?.question_version||!item.question?.rubric_version||!Array.isArray(item.files)||!item.files.length)throw new CliError('清单缺少题目版本或材料文件');
  for(const field of ['task_name','task_type','question','answer_approach','reference_answer'])if(typeof item.question[field]!=='string'||!item.question[field].trim())throw new CliError('本地题包缺少交付字段');
  if(!Array.isArray(item.question.rubric)||!item.question.rubric.length)throw new CliError('本地题包缺少rubric');
  const files=[];
  for(const file of item.files){
   if(typeof file.path!=='string'||!file.path.toLowerCase().endsWith('.docx')||!/^([0-9a-f]{64})$/.test(file.sha256))throw new CliError('材料须提供DOCX路径及SHA-256');
   const bytes=await readFile(resolve(dirname(resolve(manifestPath)),file.path));
   if(sha256Hex(bytes)!==file.sha256)throw new CliError('本地材料SHA-256不符，未上传');
   const filename=typeof file.name==='string'&&file.name.trim()?basename(file.name.trim()):basename(file.path);
   files.push({bytes,filename});
  }
  items.push({...item,files});
 }
 const path=resolve(output),cacheRoot=join(dirname(path),'local-pdf-cache');
 const state:any={version:1,stage:'draft',mode:'local',target,attachment_format:'pdf',manifest_sha256:sha256Hex(manifest),created_at:new Date().toISOString(),items:items.map(item=>({workflow_id:item.workflow_id,question_version:item.question.question_version,rubric_version:item.question.rubric_version,status:'pending'}))};
 await writeExclusiveJson(path,state,'无法创建本地交付进度文件；目标须不存在且父目录可写',false);
 const save=()=>atomicWriteJson(path,state,false);
 const tablePath=`/bitable/v1/apps/${target.base_token}/tables/${target.table_id}`;
 const listFields=(fields:string[])=>tablePath+'/records?field_names='+encodeURIComponent(JSON.stringify(fields));

 const session=await createFeishuDeliverySession();
 try{
  for(const [index,item] of items.entries()){
   if(signal?.aborted)break;
   const receipt=state.items[index];receipt.status='preparing';await save();
   let enteredRecordWrite=false;
   try{
    const legacyStems=materialPdfBaseNames(item.files),docxNames=legacyStems.map(stem=>`${stem}.docx`),legacyPdfNames=legacyStems.map(stem=>`${stem}.pdf`);
    const isUpgradeableAttachmentFormat=(filesField:unknown)=>hasExactAttachmentNames(filesField,docxNames)||hasExactAttachmentNames(filesField,legacyPdfNames)||hasExactAttachmentNames(filesField,['材料.docx'])||isLegacyHashAttachmentList(filesField);
    const knownCurrentNames=await peekCachedMaterialPdfNames(item.files,item.workflow_id,cacheRoot);
    const delivered=await deliverQuestionToFeishu({
     workflowId:item.workflow_id,
     question:item.question,
     stage:'draft',
     target,
     attachmentFormat:'pdf',
     session,
     signal,
     attachments:{
      knownCurrentNames,
      knownUpgradeableAttachmentFormat:isUpgradeableAttachmentFormat,
      async prepare(){
       const pdfs=await materialPdfAttachments(item.files,item.workflow_id,cacheRoot);
       return{
        currentNames:pdfs.map(file=>file.name),
        payloads:pdfs.map(file=>({name:file.name,bytes:file.bytes,mimeType:'application/pdf'})),
        isUpgradeableAttachmentFormat,
       };
      },
     },
     async onProgressOperation(operation){
      receipt.operation=operation;
      if(operation==='record_write'){receipt.status='dispatching';enteredRecordWrite=true;}
      await save();
     },
    });
    receipt.record_id=delivered.record_id;
    if(delivered.create_client_token)receipt.create_client_token=delivered.create_client_token;
    receipt.verification=delivered.verification;
    receipt.status=delivered.status==='succeeded'&&delivered.verification?.status==='passed'?'succeeded':'failed';
    await save();
   }catch(error:any){
    const knownFailure=error instanceof VerificationError||!enteredRecordWrite;
    receipt.status=knownFailure?'failed':'unknown';
    if(error?.feishu_verification)receipt.verification=error.feishu_verification;
    receipt.error=error instanceof CliError?error.message:error instanceof VerificationError?error.code:error instanceof FeishuError?error.code:'本地转换或飞书调用失败';
    await save();
   }
   if(receipt.status!=='succeeded')break;
  }

  const rows=await session.api.list(listFields(['题目ID','系统同步ID','输入附件']));
  state.reconciliation={checked_at:new Date().toISOString(),missing:[],duplicates:[],non_pdf:[]};
  for(const item of state.items){
   const matches=rows.filter(r=>r.fields?.['题目ID']===item.workflow_id||r.fields?.['系统同步ID']===item.workflow_id);
   if(!matches.length)state.reconciliation.missing.push(item.workflow_id);
   if(matches.length>1)state.reconciliation.duplicates.push(item.workflow_id);
   if(matches.some(r=>!Array.isArray(r.fields?.['输入附件'])||!r.fields['输入附件'].length||r.fields['输入附件'].some((f:any)=>!f.name?.endsWith('.pdf'))))state.reconciliation.non_pdf.push(item.workflow_id);
  }
  await save();
 }finally{
  await session.close();
 }
 const complete=state.items.every((item:any)=>item.status==='succeeded')&&!state.reconciliation.missing.length&&!state.reconciliation.duplicates.length&&!state.reconciliation.non_pdf.length;
 return{outcome:complete?'complete':'partial',data:{progress_file:path,total:state.items.length,succeeded:state.items.filter((i:any)=>i.status==='succeeded').length,reconciliation:state.reconciliation,note:'仅核验本地快照交付；未更新后端状态或核对数据库当前版本。'}};
}
