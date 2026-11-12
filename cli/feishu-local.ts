/**
 * 职责：从显式本地题包清单交付豆包飞书草稿，不请求业务API、不连接数据库。
 * 入口：syncLocalFeishu()供feishu local-sync调用；复用公共字段投影、核对、转换器和飞书CLI传输。
 * 边界：仅上传清单快照为未完成草稿；进度文件保存回执，未知写入停止，不更新系统归档状态。
 */
import {readFile,writeFile,rename} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {CliError} from './client';
import type {FeishuCliTarget} from './feishu';
import {feishuClient,ensureFeishuSchema} from '../server/publishing/feishu-api';
import {feishuTextFields,compareFeishuText} from '../server/publishing/feishu-verification';
import {convertMaterialDocxToImagePdf} from '../server/publishing/material-pdf';
import {canonicalJson} from '../shared/workflow-config';
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

export async function syncLocalFeishu(manifestPath:string,output:string,target:FeishuCliTarget,signal?:AbortSignal){
 const manifest=await readFile(resolve(manifestPath));
 const input=JSON.parse(manifest.toString('utf8'));
 if(input?.version!==1||!Array.isArray(input.items)||!input.items.length||input.items.length>1000)throw new CliError('本地清单须为version=1及1至1000项items');
 const ids=new Set<string>();
 const items=[];
 for(const item of input.items){
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item.workflow_id)||ids.has(item.workflow_id))throw new CliError('本地清单题目ID无效或重复');
  ids.add(item.workflow_id);
  if(!item.question?.question_version||!item.question?.rubric_version||!Array.isArray(item.files)||!item.files.length)throw new CliError('清单缺少题目版本或材料文件');
  for(const field of ['task_name','task_type','question','answer_approach','reference_answer'])if(typeof item.question[field]!=='string'||!item.question[field].trim())throw new CliError('本地题包缺少交付字段');
  if(!Array.isArray(item.question.rubric)||!item.question.rubric.length)throw new CliError('本地题包缺少rubric');
  const files=[];
  for(const file of item.files){
   if(typeof file.path!=='string'||!file.path.toLowerCase().endsWith('.docx')||!/^([0-9a-f]{64})$/.test(file.sha256))throw new CliError('材料须提供DOCX路径及SHA-256');
   const bytes=await readFile(resolve(dirname(resolve(manifestPath)),file.path));
   if(sha(bytes)!==file.sha256)throw new CliError('本地材料SHA-256不符，未上传');
   files.push({bytes});
  }
  items.push({...item,files});
 }
 const path=resolve(output),state:any={version:1,stage:'draft',mode:'local',target,attachment_format:'pdf',manifest_sha256:sha(manifest),created_at:new Date().toISOString(),items:items.map(item=>({workflow_id:item.workflow_id,question_version:item.question.question_version,rubric_version:item.question.rubric_version,status:'pending'}))};
 await writeFile(path,JSON.stringify(state,null,2),{flag:'wx',mode:0o600});
 const save=async()=>{const temp=path+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(state,null,2),{flag:'wx',mode:0o600});await rename(temp,path);};
 const tablePath=`/bitable/v1/apps/${target.base_token}/tables/${target.table_id}`;
 // 本地回执独立保存，不把本地交付伪装为后端归档或同步事件。
 for(const [index,item] of items.entries()){
  if(signal?.aborted)break;
  const receipt=state.items[index];receipt.status='preparing';await save();
  let api:Awaited<ReturnType<typeof feishuClient>>|undefined;
  let wrote=false;
  try{
   const names=item.files.map((f:{bytes:Uint8Array})=>`材料-${sha(f.bytes).slice(0,16)}.pdf`);
   api=await feishuClient();
   await ensureFeishuSchema(api,target.base_token,target.table_id);
   const rows=await api.list(tablePath+'/records');
   const matches=rows.filter(r=>r.fields?.['题目ID']===item.workflow_id||r.fields?.['系统同步ID']===item.workflow_id);
   if(matches.length>1)throw new CliError('目标表存在重复题目ID');
   let existing=matches[0];
   const expected=feishuTextFields(item.workflow_id,item.question,'未完成');
   const legacy=feishuTextFields(item.workflow_id,item.question,'未完成','legacy');
   if(existing?.fields?.['考点rubric']===legacy['考点rubric'])expected['考点rubric']=legacy['考点rubric']!;
   const hasNames=(value:any,extensions:string[])=>Array.isArray(value)&&value.length===extensions.length&&value.every((f:any,i:number)=>f.name===extensions[i]);
   if(existing){
    if(compareFeishuText(expected,existing.fields).length)throw new CliError('远端正文字段与清单快照不同，未覆盖');
    if(!hasNames(existing.fields['输入附件'],names)&&!hasNames(existing.fields['输入附件'],names.map((n:string)=>n.replace(/\.pdf$/,'.docx'))))throw new CliError('远端附件与本地材料摘要不同，未覆盖');
   }
   if(!existing||!hasNames(existing.fields['输入附件'],names)){
    // 转换可能超过认证预算，转换前关闭传输，完成后重新建立同身份连接并查重。
    await api.close();api=undefined;
    const pdfs=await convertMaterialDocxToImagePdf(item.files,item.workflow_id,join(dirname(path),'local-pdf-cache'));
    api=await feishuClient();
    const fresh=(await api.list(tablePath+'/records')).filter(r=>r.fields?.['题目ID']===item.workflow_id||r.fields?.['系统同步ID']===item.workflow_id);
    if(fresh.length!==(existing?1:0)||fresh[0]?.record_id!==existing?.record_id||canonicalJson(fresh[0]?.fields??null)!==canonicalJson(existing?.fields??null))throw new CliError('转换期间远端记录改变，未写入');
    const attachments=[];
    for(const [i,bytes] of pdfs.entries()){
     const form=new FormData();form.set('file_name',names[i]!);form.set('parent_type','bitable_file');form.set('parent_node',target.base_token);form.set('size',String(bytes.byteLength));form.set('file',new Blob([new Uint8Array(bytes)],{type:'application/pdf'}),names[i]!);
     const uploaded=await api.call('/drive/v1/medias/upload_all','POST',form);
     if(typeof uploaded.file_token!=='string')throw new CliError('飞书上传缺少file_token');
     attachments.push({file_token:uploaded.file_token});
    }
    receipt.status='dispatching';receipt.create_client_token=randomUUID();await save();wrote=true;
    const result=existing?await api.call(tablePath+'/records/'+existing.record_id,'PUT',{fields:{'输入附件':attachments}}):await api.call(tablePath+'/records?client_token='+receipt.create_client_token,'POST',{fields:{...expected,'输入附件':attachments}});
    receipt.record_id=result.record?.record_id??existing?.record_id;
    receipt.uploaded_tokens=attachments.map(a=>a.file_token);await save();
   }else receipt.record_id=existing.record_id;
   if(typeof receipt.record_id!=='string')throw new CliError('飞书缺少record_id');
   const actual=(await api.call(tablePath+'/records/'+receipt.record_id)).record?.fields??{};
   const differences=compareFeishuText(expected,actual);
   if(!hasNames(actual['输入附件'],names)||receipt.uploaded_tokens&&actual['输入附件'].some((f:any,i:number)=>f.file_token!==receipt.uploaded_tokens[i]))differences.push({field:'输入附件',expected_length:names.length,actual_length:null,first_difference:0});
   receipt.verification={status:differences.length?'failed':'passed',differences,checked_at:new Date().toISOString()};
   receipt.status=differences.length?'failed':'succeeded';await save();
  }catch(error){receipt.status=wrote?'unknown':'failed';receipt.error=error instanceof CliError?error.message:'本地转换或飞书调用失败';await save();}
  finally{await api?.close();}
  if(receipt.status!=='succeeded')break;
 }
 const api=await feishuClient();
 try{
  const rows=await api.list(tablePath+'/records');
  state.reconciliation={checked_at:new Date().toISOString(),missing:[],duplicates:[],non_pdf:[]};
  for(const item of state.items){
   const matches=rows.filter(r=>r.fields?.['题目ID']===item.workflow_id||r.fields?.['系统同步ID']===item.workflow_id);
   if(!matches.length)state.reconciliation.missing.push(item.workflow_id);
   if(matches.length>1)state.reconciliation.duplicates.push(item.workflow_id);
   if(matches.some(r=>!Array.isArray(r.fields?.['输入附件'])||!r.fields['输入附件'].length||r.fields['输入附件'].some((f:any)=>!f.name?.endsWith('.pdf'))))state.reconciliation.non_pdf.push(item.workflow_id);
  }
  await save();
 }finally{await api.close();}
 const complete=state.items.every((item:any)=>item.status==='succeeded')&&!state.reconciliation.missing.length&&!state.reconciliation.duplicates.length&&!state.reconciliation.non_pdf.length;
 return{outcome:complete?'complete':'partial',data:{progress_file:path,total:state.items.length,succeeded:state.items.filter((i:any)=>i.status==='succeeded').length,reconciliation:state.reconciliation,note:'仅核验本地快照交付；未更新后端状态或核对数据库当前版本。'}};
}
