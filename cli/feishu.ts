/**
 * 职责：CLI飞书目标参数与固定题目清单的逐题交付，复用本机HTTP API，不读取飞书凭证或连接数据库。
 * 入口：feishuTarget()校验目标；syncFeishuBatch()供commands.ts使用，保存逐题回执及未知请求，绝不自动重发。
 */
import {resolve} from 'node:path';
import {reconcileFeishuDraft} from './feishu-reconcile';
import {ApiClient,CliError} from './client';
import {atomicWriteJson,writeExclusiveJson} from './shared';
import {isEvaluationPipelineSealed} from '../shared/step-registry';

export interface FeishuCliTarget {base_token:string;table_id:string}
export type FeishuCliAttachmentFormat='docx'|'pdf';
export const FEISHU_CONFIG_TIMEOUT_MS=180000;
export const FEISHU_REQUEST_TIMEOUT_MS=900000;
export function feishuTarget(base:unknown,table:unknown):FeishuCliTarget|undefined{
 if(base===undefined&&table===undefined)return;
 if(typeof base!=='string'||!/^[A-Za-z0-9]{10,100}$/.test(base)||typeof table!=='string'||!/^tbl[A-Za-z0-9]{6,80}$/.test(table))throw new CliError('--base-token和--table须同时提供有效ID');
 return{base_token:base,table_id:table};
}
export function feishuAttachmentFormat(value:unknown):FeishuCliAttachmentFormat|undefined{
 if(value===undefined)return;
 if(value!=='docx'&&value!=='pdf')throw new CliError('--attachment-format 须为 docx 或 pdf');
 return value;
}

/** 旧API可能忽略目标body；先读能力标记，未加载新接口就停止，绝不降级上传。 */
export async function readFeishuConfig(api:ApiClient,projectId:string,signal?:AbortSignal,requireDraftSync=false,requireAttachmentFormat=false,requireCombinedMaterial=false){
 let config:any;
 try{config=await api.json(`/api/projects/${projectId}/feishu-delivery`,'GET',undefined,signal);}
 catch(error){if(error instanceof CliError&&error.detail.http_status===404)throw new CliError('API尚未加载飞书配置接口，未执行上传；请按授权重载服务后使用',{kind:'feature_unavailable',outcome_unknown:false});throw error;}
 if(config?.capabilities?.target_override!==true)throw new CliError('API未声明支持指定目标表，未执行上传',{kind:'feature_unavailable',outcome_unknown:false});
 if(requireDraftSync&&config?.capabilities?.draft_sync!==true)throw new CliError('API尚未声明支持出题后草稿上传，未执行上传；请按授权重载服务后使用',{kind:'feature_unavailable',outcome_unknown:false});
 if(requireAttachmentFormat&&config?.capabilities?.attachment_format!==true)throw new CliError('API尚未声明支持交付附件格式（docx/pdf），未执行上传；请按授权重载服务后使用',{kind:'feature_unavailable',outcome_unknown:false});
 if(requireCombinedMaterial&&config?.capabilities?.combined_material!==true)throw new CliError('API尚未加载合册交付能力，未执行上传',{kind:'feature_unavailable',outcome_unknown:false});
 return config;
}

/** 首先只读核对全部题目归属/达标/归档；支持有界并发批量同步（每题发送前落盘dispatching，任一失败或未知响应立即停止领取新题，在途请求正常落盘绝不中断重发）。 */
export async function syncFeishuBatch(api:ApiClient,projectId:string,ids:string[],output:string,target:FeishuCliTarget|undefined,signal?:AbortSignal,stage:'draft'|'archived'='archived',attachmentFormat?:FeishuCliAttachmentFormat,combinedMaterial=false,concurrency=1){
 if(combinedMaterial&&!attachmentFormat)throw new CliError('--combined-material须显式指定--attachment-format docx或pdf');
 if(!ids.length||ids.length>1000)throw new CliError('飞书批次须明确指定1至1000道题');
 if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>8)throw new CliError('--concurrency 须为 1 至 8 的整数');
 const settings=await readFeishuConfig(api,projectId,signal,stage==='draft',attachmentFormat!==undefined,combinedMaterial);
 let project:any;
 try{project=await api.json(`/api/projects/${projectId}/questions?ids=${encodeURIComponent(ids.join(','))}`,'GET',undefined,signal);}
 catch(error){
  // 旧运行服务仅在明确404时回退；超时/500不追加一次全项目昂贵查询。
  if(!(error instanceof CliError)||error.detail.http_status!==404)throw error;
  project=await api.json(`/api/projects/${projectId}`,'GET',undefined,signal);
 }
 if(!Array.isArray(project.workflows)||!project.workflow_status)throw new CliError('项目响应缺少题目状态',{kind:'invalid_response'});
 const sealed=isEvaluationPipelineSealed();
 for(const id of ids){
  const workflow=project.workflows.find((w:any)=>w.id===id),steps=project.workflow_status[id]?.steps;
  const eligible=stage==='archived'
   ?(sealed||workflow?.current_decision==='accepted')&&Array.isArray(steps)&&steps.some((s:any)=>s.ordinal===8&&s.status==='succeeded')
   :Array.isArray(steps)&&steps.some((s:any)=>s.ordinal===4&&s.status==='succeeded')&&!steps.some((s:any)=>s.ordinal===8&&s.status==='succeeded');
  if(!workflow||workflow.workflow_kind!=='question'||!eligible)throw new CliError(`题目${id}不属于该期或未满足${stage==='draft'?'出题完成且未归档':'达标归档'}条件，未上传本批题目`);
 }
 if(!target){
  const configured=settings.default_target;
  if(configured?.table_id)target=feishuTarget(configured.base_token,configured.table_id);
  else throw new CliError('本期尚无固定表ID；请先创建或指定目标表，再执行批次，避免批次中途改向');
 }
 const effectiveAttachmentFormat:FeishuCliAttachmentFormat=attachmentFormat??(settings.attachment_format==='pdf'?'pdf':'docx');
 const workerCount=Math.min(concurrency,ids.length);
 const path=resolve(output),state:any={version:1,stage,project_id:projectId,workflow_ids:ids,target,attachment_format:effectiveAttachmentFormat,combined_material:combinedMaterial,concurrency:workerCount,created_at:new Date().toISOString(),items:ids.map(workflow_id=>({workflow_id,status:'pending'}))};
 await writeExclusiveJson(path,state,'进度文件必须不存在且父目录可写；未上传本批题目',false);
 let persistChain=Promise.resolve();
 const persist=()=>{
  const run=()=>atomicWriteJson(path,state,false);
  persistChain=persistChain.then(run,run);
  return persistChain;
 };
 const reconcile=async(item:any)=>{
  if(stage!=='draft'||!combinedMaterial||signal?.aborted)return false;
  item.original_receipt??=item.receipt;await persist();
  try{
   const receipt=await reconcileFeishuDraft(api,item.workflow_id,projectId,target!,effectiveAttachmentFormat,signal);
   if(!receipt)return false;
   item.receipt=receipt;item.status='succeeded';item.reconciled_at=new Date().toISOString();await persist();return true;
  }catch{item.reconciliation_failed=true;await persist();return false;}
 };
 let nextIndex=0,stopDispatching=false;
 const processItem=async(item:any)=>{
  item.status='dispatching';item.dispatched_at=new Date().toISOString();await persist();
  try{
   const route=stage==='draft'?'feishu-draft-sync':'feishu-sync';
   const receipt=await api.json(`/api/workflows/${item.workflow_id}/${route}`,'POST',{target,attachment_format:effectiveAttachmentFormat,...(combinedMaterial?{combined_material:true}:{})},signal,{},FEISHU_REQUEST_TIMEOUT_MS);
   item.receipt=receipt;item.status=receipt.status==='succeeded'&&receipt.verification?.status==='passed'?'succeeded':receipt.status==='in_progress'?'in_progress':'failed';await persist();
   if(item.status!=='succeeded'){
    if(await reconcile(item))return;
    stopDispatching=true;
   }
  }catch(error){
   const detail=error instanceof CliError?error.detail:{};
   // 飞书核对失败按HTTP502返回；从同题安全回执恢复具体差异，不把旧回执当作本次响应。
   let confirmedFailure=false;
   if(detail.http_status===502){
    try{
     const workflow=await api.json(`/api/workflows/${item.workflow_id}?view=status`,'GET',undefined,signal);
     const receipt=workflow.steps?.find((step:any)=>step.ordinal===8)?.result?.feishu_sync;
     const checked=Date.parse(receipt?.verification?.checked_at??'');
     const destination=typeof receipt?.url==='string'?new URL(receipt.url):undefined;
     if(target&&receipt?.status==='failed'&&checked>=Date.parse(item.dispatched_at)&&destination?.pathname===`/base/${target.base_token}`&&destination.searchParams.get('table')===target.table_id){
      item.receipt=receipt;confirmedFailure=receipt.verification.status==='failed';
     }
    }catch{item.receipt_lookup_failed=true;}
   }
   item.status=confirmedFailure?'failed':detail.outcome_unknown===true?'unknown':'failed';item.error=error instanceof CliError?{message:error.message,...detail,...(confirmedFailure?{outcome_unknown:false}:{})}:{kind:'client_error'};
   await persist();
   if(await reconcile(item))return;
   // 失败后保留尚未派发清单；尤其不能因超时或空响应换key重放远端写请求。
   stopDispatching=true;
  }
 };
 const worker=async()=>{
  while(!stopDispatching&&!signal?.aborted){
   const index=nextIndex++;
   if(index>=state.items.length)return;
   await processItem(state.items[index]);
  }
 };
 await Promise.all(Array.from({length:workerCount},()=>worker()));
 const quotaExceeded=state.items.some((item:any)=>item.receipt?.reason_code==='feishu_api_1061101'||item.original_receipt?.reason_code==='feishu_api_1061101');
 const quotaNote=quotaExceeded?'检测到 feishu_api_1061101：目标飞书租户云空间容量已满，请清理云盘/历史大附件或切换有剩余容量的多维表格后补传。':'';
 return{outcome:state.items.every((item:any)=>item.status==='succeeded')?'complete':'partial',data:{progress_file:path,project_id:projectId,target,attachment_format:effectiveAttachmentFormat,stage,concurrency:workerCount,items:state.items,total:ids.length,succeeded:state.items.filter((item:any)=>item.status==='succeeded').length,verified:state.items.filter((item:any)=>item.receipt?.verification?.status==='passed').length,verification_failed:state.items.filter((item:any)=>item.receipt?.verification?.status==='failed').length,verification_incomplete:state.items.filter((item:any)=>item.status!=='pending'&&item.receipt?.verification?.status!=='passed'&&item.receipt?.verification?.status!=='failed').length,note:(quotaNote?quotaNote:'')+(stage==='draft'?'草稿仅表示出题结果已上传飞书，字段“题目是否完成”为未完成；不代表评分、达标、归档或平台验收。unknown先核对远端，pending未派发。补传须明确指定剩余ID并使用新的进度文件，不自动重试。':'核对结果见每题receipt.verification；旧回执无verification不代表本次核对通过。仅成功回执代表已提交；unknown先核对远端，pending未派发。补传须明确指定剩余ID并使用新的进度文件，不自动重试。')}};
}
