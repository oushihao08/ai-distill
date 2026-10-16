/**
 * 职责：项目阶段扩展配置的共享契约与结构校验，不解释业务计分规则。
 * 入口：validateWorkflowConfig() 供步骤设置保存及派发冻结使用；缺省不改变旧任务。
 */
import type {ModelApiConfig} from './types';
export type WorkflowContract='legacy'|'model_report_v1';
export interface HookAction {
 id:string;script:string;files:string[];mode:'sync'|'async';params:Record<string,unknown>;
 timeout_ms:number;idempotent:boolean;input_purpose?:string;model_request?:{config:ModelApiConfig;prompt:string};
}
export interface WorkflowConfig {
 content_contract?:'work_legal_v1';contract:WorkflowContract;rules_text:string;reference_answer:'none'|'calibration';
 hooks:{before:HookAction[];after:HookAction[]};
}
export type ScoringPolicy=Pick<WorkflowConfig,'contract'|'rules_text'|'reference_answer'>;
/** 新契约含任意 JSON 业务字段，排序对象键以兼容 PostgreSQL JSONB 往返。数组顺序保留。 */
export function canonicalJson(value:unknown):string{
 const order=(item:unknown):unknown=>Array.isArray(item)?item.map(order):item&&typeof item==='object'?Object.fromEntries(Object.keys(item).sort().map(key=>[key,order((item as Record<string,unknown>)[key])])):item;
 return JSON.stringify(order(value));
}
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const fail=():never=>{throw new Error('项目流程配置格式无效');};
const keys=(value:Record<string,unknown>,allowed:string[])=>{if(Object.keys(value).some(key=>!allowed.includes(key)))fail();};
const relativePath=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=500&&!/[\\\x00-\x1f]/.test(value)&&!value.startsWith('/')&&!/^[a-z]:/i.test(value)&&value.split('/').every(part=>!!part&&part!=='.'&&part!=='..');
function actions(raw:unknown):HookAction[]{
 if(!Array.isArray(raw)||raw.length>20)return fail();
 const result=raw.map(value=>{
  if(!record(value))return fail();
  keys(value,['id','script','files','mode','params','timeout_ms','idempotent','input_purpose','model_request']);
  if(typeof value.id!=='string'||!/^[-a-zA-Z0-9_]{1,80}$/.test(value.id)||!relativePath(value.script)||!value.script.endsWith('.ts'))return fail();
  if(!Array.isArray(value.files)||!value.files.length||value.files.length>100||value.files.some(file=>!relativePath(file))||!value.files.includes(value.script)||new Set(value.files).size!==value.files.length)return fail();
  const mode=value.mode??'sync',params=value.params??{},timeout_ms=value.timeout_ms??60000,idempotent=value.idempotent??false;
  if(!['sync','async'].includes(mode as string)||!record(params)||typeof timeout_ms!=='number'||!Number.isInteger(timeout_ms)||timeout_ms<1||timeout_ms>1800000||typeof idempotent!=='boolean')return fail();
  if(value.input_purpose!==undefined&&(typeof value.input_purpose!=='string'||!value.input_purpose.trim()||value.input_purpose.length>1000||mode!=='sync'))return fail();
  let model_request:HookAction['model_request'];
  if(value.model_request!==undefined){
   const request=value.model_request;
   if(!record(request))return fail();keys(request,['config','prompt']);
   if(typeof request.prompt!=='string'||!request.prompt.trim()||request.prompt.length>100000||!record(request.config))return fail();
   const config=request.config;keys(config,['provider','model','base_url','enable_thinking','max_tokens']);
   if(!['qwen','kimi','deepseek','doubao','openrouter'].includes(config.provider as string)||typeof config.model!=='string'||!config.model.trim()||typeof config.base_url!=='string'||!config.base_url.startsWith('https://')||config.enable_thinking!==undefined&&typeof config.enable_thinking!=='boolean'||config.max_tokens!==undefined&&(typeof config.max_tokens!=='number'||!Number.isInteger(config.max_tokens)||config.max_tokens<1))return fail();
   let url:URL;try{url=new URL(config.base_url);}catch{return fail();}
   if(url.username||url.password||url.search||url.hash||config.model.length>1000||config.base_url.length>2000)return fail();
   if(idempotent) return fail(); // 无供应商幂等请求保证，状态未知的收费调用不能自动重试。
   model_request={config:JSON.parse(JSON.stringify(config)) as ModelApiConfig,prompt:request.prompt};
  }
  // JSONB/API 配置只能保存 JSON 数据；拒绝函数、循环、非有限数及过大的参数。
  let json:string;try{json=JSON.stringify(params,(_key,item)=>{if(typeof item==='function'||typeof item==='bigint'||typeof item==='undefined'||typeof item==='number'&&!Number.isFinite(item))fail();return item;});}catch{return fail();}
  if(json.length>64000)return fail();
  return {id:value.id,script:value.script,files:[...value.files] as string[],mode:mode as 'sync'|'async',params:JSON.parse(json) as Record<string,unknown>,timeout_ms,idempotent,...(typeof value.input_purpose==='string'?{input_purpose:value.input_purpose}:{}),...(model_request?{model_request}:{})};
 });
 if(new Set(result.map(action=>action.id)).size!==result.length)return fail();
 return result;
}
/** 未配置时返回 undefined，以保留历史快照及配置的精确形状。 */
export function validateWorkflowConfig(raw:unknown):WorkflowConfig|undefined{
 if(raw===undefined)return undefined;
 if(!record(raw))return fail();
 keys(raw,['contract','rules_text','reference_answer','hooks','content_contract']);
 if(raw.content_contract!==undefined&&raw.content_contract!=='work_legal_v1')return fail();
 const contract=raw.contract??'legacy',rules_text=raw.rules_text??'',reference_answer=raw.reference_answer??'none',hooks=raw.hooks??{};
 if(!['legacy','model_report_v1'].includes(contract as string)||typeof rules_text!=='string'||rules_text.length>200000||!['none','calibration'].includes(reference_answer as string)||!record(hooks))return fail();
 if(contract==='legacy'&&reference_answer!=='none')return fail();
 keys(hooks,['before','after']);
 return {...(raw.content_contract?{content_contract:raw.content_contract as 'work_legal_v1'}:{}),contract:contract as WorkflowContract,rules_text,reference_answer:reference_answer as 'none'|'calibration',hooks:{before:actions(hooks.before??[]),after:actions(hooks.after??[])}};
}
