/**
 * 职责：CLI飞书目标参数与固定题目清单的逐题交付，复用本机HTTP API，不读取飞书凭证或连接数据库。
 * 入口：feishuTarget()校验目标；syncFeishuBatch()供commands.ts使用，保存逐题回执及未知请求，绝不自动重发。
 */
import {writeFile,rename,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ApiClient,CliError} from './client';

export interface FeishuCliTarget {base_token:string;table_id:string}
export const FEISHU_REQUEST_TIMEOUT_MS=180000;
export function feishuTarget(base:unknown,table:unknown):FeishuCliTarget|undefined{
 if(base===undefined&&table===undefined)return;
 if(typeof base!=='string'||!/^[A-Za-z0-9]{10,100}$/.test(base)||typeof table!=='string'||!/^tbl[A-Za-z0-9]{6,80}$/.test(table))throw new CliError('--base-token和--table须同时提供有效ID');
 return{base_token:base,table_id:table};
}

/** 旧API可能忽略目标body；先读能力标记，未加载新接口就停止，绝不降级上传。 */
export async function readFeishuConfig(api:ApiClient,projectId:string,signal?:AbortSignal){
 let config:any;
 try{config=await api.json(`/api/projects/${projectId}/feishu-delivery`,'GET',undefined,signal);}
 catch(error){if(error instanceof CliError&&error.detail.http_status===404)throw new CliError('API尚未加载飞书配置接口，未执行上传；请按授权重载服务后使用',{kind:'feature_unavailable',outcome_unknown:false});throw error;}
 if(config?.capabilities?.target_override!==true)throw new CliError('API未声明支持指定目标表，未执行上传',{kind:'feature_unavailable',outcome_unknown:false});
 return config;
}

/** 首先只读核对全部题目归属/达标/归档；每题发送前落盘dispatching，未知响应立即停止。 */
export async function syncFeishuBatch(api:ApiClient,projectId:string,ids:string[],output:string,target:FeishuCliTarget|undefined,signal?:AbortSignal){
 if(!ids.length||ids.length>1000)throw new CliError('飞书批次须明确指定1至1000道题');
 const settings=await readFeishuConfig(api,projectId,signal);
 const project=await api.json(`/api/projects/${projectId}`,'GET',undefined,signal);
 if(!Array.isArray(project.workflows)||!project.workflow_status)throw new CliError('项目响应缺少题目状态',{kind:'invalid_response'});
 for(const id of ids){
  const workflow=project.workflows.find((w:any)=>w.id===id),steps=project.workflow_status[id]?.steps;
  if(!workflow||workflow.workflow_kind!=='question'||workflow.current_decision!=='accepted'||!Array.isArray(steps)||!steps.some((s:any)=>s.ordinal===8&&s.status==='succeeded'))throw new CliError(`题目${id}不属于该期或尚未达标归档，未上传本批题目`);
 }
 if(!target){
  const configured=settings.default_target;
  if(configured?.table_id)target=feishuTarget(configured.base_token,configured.table_id);
  else throw new CliError('本期尚无固定表ID；请先创建或指定目标表，再执行批次，避免批次中途改向');
 }
 const path=resolve(output),state:any={version:1,project_id:projectId,workflow_ids:ids,target,created_at:new Date().toISOString(),items:ids.map(workflow_id=>({workflow_id,status:'pending'}))};
 try{await writeFile(path,JSON.stringify(state,null,2),{flag:'wx',mode:0o600});}
 catch{throw new CliError('进度文件必须不存在且父目录可写；未上传本批题目',{kind:'file_error'});}
 const persist=async()=>{
  const temporary=path+'.'+randomUUID()+'.tmp';
  try{await writeFile(temporary,JSON.stringify(state,null,2),{flag:'wx',mode:0o600});await rename(temporary,path);}
  finally{await rm(temporary,{force:true});}
 };
 for(const item of state.items){
  if(signal?.aborted)break;
  item.status='dispatching';item.dispatched_at=new Date().toISOString();await persist();
  try{
   const receipt=await api.json(`/api/workflows/${item.workflow_id}/feishu-sync`,'POST',{target},signal,{},FEISHU_REQUEST_TIMEOUT_MS);
   item.receipt=receipt;item.status=receipt.status==='succeeded'?'succeeded':receipt.status==='in_progress'?'in_progress':'failed';await persist();
  }catch(error){
   const detail=error instanceof CliError?error.detail:{};
   // 飞书核对失败按HTTP502返回；从同题安全回执恢复具体差异，不把旧回执当作本次响应。
   let confirmedFailure=false;
   if(detail.http_status===502){
    try{
     const workflow=await api.json(`/api/workflows/${item.workflow_id}`,'GET',undefined,signal);
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
   // 失败后保留尚未派发清单；尤其不能因超时或空响应换key重放远端写请求。
   break;
  }
 }
 return{outcome:state.items.every((item:any)=>item.status==='succeeded')?'complete':'partial',data:{progress_file:path,project_id:projectId,target,items:state.items,total:ids.length,succeeded:state.items.filter((item:any)=>item.status==='succeeded').length,verified:state.items.filter((item:any)=>item.receipt?.verification?.status==='passed').length,verification_failed:state.items.filter((item:any)=>item.receipt?.verification?.status==='failed').length,verification_incomplete:state.items.filter((item:any)=>item.status!=='pending'&&item.receipt?.verification?.status!=='passed'&&item.receipt?.verification?.status!=='failed').length,note:'核对结果见每题receipt.verification；旧回执无verification不代表核对通过。仅成功回执代表已提交；unknown先核对远端，pending未派发。补传须明确指定剩余ID并使用新的进度文件，不自动重试。'}};
}
