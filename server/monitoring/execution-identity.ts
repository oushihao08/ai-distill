/** 冻结请求的安全执行身份投影，供队列和监控读取；不返回配置正文、凭证或推断实际返回模型。 */
import {resolveAgentDriver} from '../agent/driver';
export interface ExecutionIdentity {provider:string|null;requested_model:string|null;reasoning_effort:string|null;executor_id?:string|null;claimed_by_pid?:number|null;generation?:number|null}
const label=(value:unknown)=>typeof value==='string'&&value.length>0&&value.length<=180&&!/[\r\n]/.test(value)?value:null;
export function frozenExecutionIdentity(row:{provider?:unknown;requested_model?:unknown;reasoning_effort?:unknown},channel:string):ExecutionIdentity{
 const model=label(row.requested_model),provider=label(row.provider),effort=label(row.reasoning_effort);
 if(channel==='agent'&&model){
  try{return{provider:resolveAgentDriver(model,provider??undefined).driver.id,requested_model:model,reasoning_effort:effort};}
  catch{return{provider:null,requested_model:model,reasoning_effort:effort};}
 }
 return{provider,requested_model:model,reasoning_effort:effort};
}
/** 仅选择允许公开的冻结标识，不读取完整API配置。 */
export const stepIdentitySql="COALESCE(a.config->'api'->>'provider',a.config->'web'->>'provider',a.config->>'provider') AS provider,COALESCE(a.config->>'model',a.config->'api'->>'model',a.config->'web'->>'provider') AS requested_model,a.config->>'reasoning_effort' AS reasoning_effort";
export const libraryIdentitySql=`CASE WHEN j.kind='prepare' THEN COALESCE(j.config_snapshot->'api'->>'provider',j.config_snapshot->'web'->>'provider') WHEN j.kind='redact' THEN COALESCE(j.config_snapshot->'settings'->'redaction'->'api'->>'provider',j.config_snapshot->'settings'->'redaction'->'web'->>'provider',j.config_snapshot->'settings'->'redaction'->>'provider') WHEN j.kind='extract' THEN j.config_snapshot->>'pdf_provider' END AS provider,
 CASE WHEN j.kind='prepare' THEN COALESCE(j.config_snapshot->'api'->>'model',j.config_snapshot->'agent'->>'model',j.config_snapshot->'web'->>'provider') WHEN j.kind='redact' THEN COALESCE(j.config_snapshot->'settings'->'redaction'->'api'->>'model',j.config_snapshot->'settings'->'redaction'->>'model',j.config_snapshot->'settings'->'redaction'->'web'->>'provider') END AS requested_model,
 CASE WHEN j.kind='prepare' THEN j.config_snapshot->'agent'->>'reasoning_effort' WHEN j.kind='redact' THEN j.config_snapshot->'settings'->'redaction'->>'reasoning_effort' END AS reasoning_effort`;
