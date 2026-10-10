/**
 * 职责：脱敏步骤选择独立 API 或本地 Agent，合并默认值并验证冻结配置。
 * 关键入口：mergeRedactionDefaults() 用于展示/入队/返修快照；validateRedactionConfig() 校验两种执行方式。
 * API 默认值复用统一模块的 OpenRouter GLM-5.3-Flash，可由 LLM_API_* 覆盖；显式 Codex 配置保持可用。
 */
import {HTTPException} from 'hono/http-exception';
import {ModelApiError,readModelApiDefaults,resolveModelApiConfig,type ModelApiConfig} from '../llm-api';
import {validateAgentModel} from '../agent/config';
import {DEFAULT_REDACTION_PROMPT} from '@shared/step-registry';
export type RedactionConfig={provider:'codex';model:string;reasoning_effort:string;prompt:string}|{provider:'api';api:ModelApiConfig;prompt:string};
function stableJson(value:unknown):string{
 const normalize=(item:unknown):unknown=>Array.isArray(item)?item.map(value=>value===undefined?null:normalize(value)):item&&typeof item==='object'?Object.fromEntries(Object.entries(item).filter(([,value])=>value!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,normalize(value)])):item;
 return JSON.stringify(normalize(value))??'undefined';
}
/** Compare the effective settings, so omitted defaults and JSON key order do not invalidate existing work. */
export function sameRedactionConfig(a:unknown,b:unknown,codexDefaults:{model:string;reasoning_effort:string}):boolean{
 try{return stableJson(mergeRedactionDefaults(a,codexDefaults))===stableJson(mergeRedactionDefaults(b,codexDefaults));}
 catch{return false;}
}
export function mergeRedactionDefaults(raw:unknown,codexDefaults:{model:string;reasoning_effort:string}){
 if(raw!==undefined&&(!raw||typeof raw!=='object'||Array.isArray(raw)))throw new HTTPException(400,{message:'脱敏设置须为JSON对象'});
 const value=(raw??{}) as Record<string,unknown>;
 // Older snapshots without an explicit provider still refer to a saved Codex model.
 if(value.provider==='codex'||value.provider===undefined&&typeof value.model==='string')return{provider:'codex',...codexDefaults,prompt:DEFAULT_REDACTION_PROMPT,...value};
 let defaults:ModelApiConfig|undefined;
 if(value.api===undefined){try{defaults=readModelApiDefaults();}catch(error){if(!(error instanceof ModelApiError))throw error;}}
 return{provider:'api',prompt:DEFAULT_REDACTION_PROMPT,...(defaults?{api:defaults}:{}),...value};
}
export function validateRedactionConfig(raw:unknown,catalog?:Parameters<typeof validateAgentModel>[2]):RedactionConfig{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new HTTPException(400,{message:'脱敏设置须为JSON对象'});
 const value=raw as Record<string,unknown>;
 const fields=value.provider==='api'?['provider','api','prompt']:['provider','model','reasoning_effort','prompt'];
 if(Object.keys(value).some(key=>!fields.includes(key)))throw new HTTPException(400,{message:'脱敏设置含不支持的字段'});
 if(typeof value.prompt!=='string'||!value.prompt.trim()||value.prompt.length>12000)throw new HTTPException(400,{message:'请填写有效的脱敏提示词'});
 if(value.provider==='api'){
  try{return{provider:'api',api:value.api===undefined?readModelApiDefaults():resolveModelApiConfig(value.api),prompt:value.prompt};}
  catch(error){if(error instanceof ModelApiError)throw new HTTPException(400,{message:'统一 API 配置无效，请选择系统已登记模型或检查服务端 API 默认设置'});throw error;}
 }
 if(value.provider!==undefined&&value.provider!=='codex')throw new HTTPException(400,{message:'脱敏执行方式无效'});
 if(typeof value.model!=='string'||!value.model.trim()||typeof value.reasoning_effort!=='string')throw new HTTPException(400,{message:'请配置脱敏 Agent 模型和推理强度'});
 validateAgentModel(value.model,value.reasoning_effort,catalog);
 return{provider:'codex',model:value.model,reasoning_effort:value.reasoning_effort,prompt:value.prompt};
}
