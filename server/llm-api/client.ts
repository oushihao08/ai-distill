/**
 * 职责：独立的纯文字大模型 API 客户端，统一消息调用、JSON 输出、完整响应、安全错误、超时和取消。
 * 关键入口：createModelApiClient().complete() / completeJson()；供作答、脱敏等业务调用，不访问工作目录或 Agent。
 * 只调用冻结配置指定的供应商；不自动换模型或供应商，不在模块内重试收费请求。
 */
import {resolveModelApiConfig,readModelApiKey} from './config';
import {ModelApiError,type ModelApiErrorKind,type ModelApiConfig,type ModelApiRequest,type ModelApiResult} from './types';
import {classifyLogError,logEvent,withLogContext} from '../logging';
function record(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function onlyFields(value:unknown,fields:string[]):asserts value is Record<string,unknown>{if(!record(value)||Object.keys(value).some(key=>!fields.includes(key)))throw new ModelApiError('configuration');}
// Only documented codes are retained. Provider message/type/param and unknown codes
// can echo private inputs, so they never become error properties or causes.
const quotaCodes = new Set(['Arrearage', 'isv.OUT_OF_SERVICE', 'PrepaidBillOverdue', 'CommodityNotPurchased']);
const authCodes = new Set(['InvalidApiKey', 'invalid_api_key', 'AccessDenied', 'access_denied', 'AccessDenied.Unpurchased', 'Model.AccessDenied', 'Workspace.AccessDenied', 'NOT AUTHORIZED']);
const rateCodes = new Set(['Throttling', 'Throttling.RateQuota', 'Throttling.AllocationQuota', 'insufficient_quota', 'Throttling.BurstRate', 'Throttling.Concurrency', 'Throttling.ServiceOverloaded', 'Throttling.ResourceExhausted', 'LimitRequests', 'limit_requests', 'limit_burst_rate', 'ResourceExhausted']);
const configCodes = new Set(['InvalidParameter', 'InvalidParameter.NotSupportEnableThinking', 'invalid_parameter_error', 'invalid_request_error', 'invalid_value', 'model_not_supported', 'ModelNotFound', 'WorkSpaceNotFound']);
const providerCodes = new Set(['InternalError', 'ServiceUnavailable', 'DataInspectionFailed', 'data_inspection_failed']);
function requestId(response: Response, data: unknown): string | null {
 const ids = [response.headers.get('x-request-id'), response.headers.get('x-dashscope-request-id'), record(data) ? data.request_id : null];
 return ids.find((id): id is string => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) ?? null;
}
function providerError(response: Response, data: unknown, config:ModelApiConfig): ModelApiError {
 const details = record(data) && record(data.error) ? data.error : data;
 const rawCode = config.provider==='qwen'&&record(details) ? details.code : undefined;
 const code = typeof rawCode === 'number' && [400,401,402,403,404,408,422,429,500,502,503].includes(rawCode) ? String(rawCode) : typeof rawCode === 'string' && [quotaCodes, authCodes, rateCodes, configCodes, providerCodes].some(codes => codes.has(rawCode)) ? rawCode : null;
 let kind: ModelApiErrorKind = 'provider';
 if ((code && quotaCodes.has(code)) || response.status === 402) kind = 'quota';
 else if (response.status === 408) kind = 'timeout';
 else if ((code && authCodes.has(code)) || response.status === 401 || response.status === 403) kind = 'authentication';
 else if ((code && rateCodes.has(code)) || response.status === 429) kind = 'rate_limit';
 else if ((code && configCodes.has(code)) || response.status === 400 || response.status === 404 || response.status === 422) kind = 'configuration';
 const retryable = kind === 'timeout' || kind === 'rate_limit' || (kind === 'provider' && response.status >= 500);
 return new ModelApiError(kind, retryable, response.status, code, requestId(response, data));
}
function parseCompletion(data: unknown, response: Response, config: ModelApiConfig, started_at: string, started: number): ModelApiResult {
 const invalid = (reason_code:string) => new ModelApiError('invalid_response', false, response.status, null, requestId(response, data),reason_code);
 if (!record(data) || data.error !== undefined || !Array.isArray(data.choices)) throw invalid('invalid_response_shape');
 if(data.choices.length!==1)throw invalid(data.choices.length===0?'missing_choice':'unexpected_choice_count');
 const choice = data.choices[0];
 if (!record(choice)) throw invalid('invalid_choice_shape');
 if(choice.finish_reason!=='stop')throw invalid('incomplete_finish_reason');
 if(!record(choice.message))throw invalid('invalid_message_shape');
 const message = choice.message;
 if(message.role!=='assistant')throw invalid('invalid_message_role');
 if(typeof message.content!=='string'||!message.content.trim())throw invalid('empty_content');
 if((message.tool_calls!=null&&(!Array.isArray(message.tool_calls)||message.tool_calls.length>0))||message.function_call!=null)throw invalid('unexpected_tool_call');
 if(message.refusal!=null)throw invalid('refusal_response');
 if (data.usage != null && !record(data.usage)) throw invalid('invalid_usage_shape');
 if (data.model != null && (typeof data.model !== 'string' || !data.model.trim())) throw invalid('invalid_model_field');
 if (data.id != null && typeof data.id !== 'string') throw invalid('invalid_completion_id');
 return {
  provider:config.provider,text: message.content, requested_model: config.model, model: typeof data.model === 'string' ? data.model : null,
  request_id: requestId(response, data), completion_id: typeof data.id === 'string' ? data.id : null,
  usage: record(data.usage) ? data.usage : null,
  started_at, finished_at: new Date().toISOString(), duration_ms: Math.max(0, Math.round(performance.now() - started)),
 };
}

export function createModelApiClient(env: NodeJS.ProcessEnv = process.env, request: (input: string, init?: RequestInit) => Promise<Response> = fetch) {
 const client={ async complete(input: ModelApiRequest): Promise<ModelApiResult> {
  onlyFields(input,['config','messages','timeout_ms','signal','response_format','call_id']);
  if(!Array.isArray(input.messages)||!input.messages.length)throw new ModelApiError('configuration');
  const messages=input.messages.map(message=>{
   onlyFields(message,['role','content']);
   if(typeof message.role!=='string'||!['system','user','assistant'].includes(message.role)||typeof message.content!=='string'||!message.content.trim())throw new ModelApiError('configuration');
   return{role:message.role,content:message.content};
  });
  if(input.response_format!==undefined){
   onlyFields(input.response_format,['type','json_schema']);
   if(input.response_format.type==='json_schema'){
    const shape=input.response_format.json_schema;
    onlyFields(shape,['name','strict','schema']);
    if(typeof shape.name!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(shape.name)||shape.strict!==true||!record(shape.schema))throw new ModelApiError('configuration');
   }else if(input.response_format.type!=='json_object'||Object.hasOwn(input.response_format,'json_schema'))throw new ModelApiError('configuration');
  }
  const timeout = input.timeout_ms === undefined ? 3600000 : input.timeout_ms;
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 2147483647 || (input.signal !== undefined && !(input.signal instanceof AbortSignal))) throw new ModelApiError('configuration');
  if (input.signal?.aborted) throw new ModelApiError('cancelled');
  const config = resolveModelApiConfig(input.config, env);
  // Resolve credentials at invocation time, outside the persisted configuration.
  const router = new URL(config.base_url).hostname === 'openrouter.ai';
  const key=readModelApiKey(config,env);
  const started_at = new Date().toISOString(); const started = performance.now();
  const controller = new AbortController();
  let abortKind: 'timeout' | 'cancelled' | undefined;
  const abort = (kind: 'timeout' | 'cancelled') => {
   if (!controller.signal.aborted) { abortKind = kind; controller.abort(); }
  };
  const cancel = () => abort('cancelled');
  input.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => abort('timeout'), timeout);
  const callContext={component:'llm_api',provider:config.provider,model:config.model,call_id:input.call_id??crypto.randomUUID()};
  try {
   withLogContext(callContext,()=>logEvent('model_api.call.started',{level:'info',timeout_ms:timeout}));
   const response = await request(config.base_url + '/chat/completions', {
    method: 'POST', redirect: 'error', signal: controller.signal,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
     model: config.model, stream: false,
     ...(config.enable_thinking !== undefined ? (router ? {reasoning:{enabled:config.enable_thinking}} : {enable_thinking:config.enable_thinking}) : {}),
     ...(input.response_format?{response_format:input.response_format}:{}),
     ...(router&&(input.response_format||config.enable_thinking!==undefined)?{provider:{require_parameters:true}}:{}),
     ...(config.max_tokens !== undefined ? { max_tokens: config.max_tokens } : {}),
     messages,
    }),
   });
   if (abortKind) throw new ModelApiError(abortKind, abortKind === 'timeout');
   let data: unknown;
   try { data = await response.json(); }
   catch (error) {
    if (abortKind) throw new ModelApiError(abortKind, abortKind === 'timeout');
    if (!(error instanceof SyntaxError)) throw new ModelApiError('network', true);
    if (response.ok) throw new ModelApiError('invalid_response', false, response.status, null, requestId(response, null),'invalid_json');
    data = null;
   }
   if (abortKind) throw new ModelApiError(abortKind, abortKind === 'timeout');
   if (!response.ok) throw providerError(response, data,config);
   const result=parseCompletion(data,response,config,started_at,started);
   withLogContext(callContext,()=>logEvent('model_api.call.completed',{level:'info',elapsed_ms:result.duration_ms,token_usage:result.usage,output_bytes:Buffer.byteLength(result.text)}));
   return result;
  } catch (error) {
   withLogContext(callContext,()=>logEvent('model_api.call.failed',{level:'error',elapsed_ms:Math.round(performance.now()-started),...classifyLogError(error)}));
   if (abortKind) throw new ModelApiError(abortKind, abortKind === 'timeout');
   if (error instanceof ModelApiError) throw error;
   throw new ModelApiError('network', true);
  } finally {
   clearTimeout(timer);
   input.signal?.removeEventListener('abort', cancel);
  }
 } };
 return{...client,async completeJson<T>(input:ModelApiRequest,validate:(value:unknown)=>T):Promise<ModelApiResult&{result:T}>{
  const completion=await client.complete({...input,response_format:input.response_format??{type:'json_object'}});
  let parsed:unknown;
  try{parsed=JSON.parse(completion.text);}
  catch{
   const safe=new ModelApiError('invalid_response',false,null,null,null,'invalid_json');
   withLogContext({component:'llm_api',provider:input.config.provider,model:input.config.model,...(input.call_id?{call_id:input.call_id}:{})},()=>logEvent('model_api.validation.failed',{level:'error',...classifyLogError(safe)}));
   throw safe;
  }
  try{return{...completion,result:validate(parsed)};}
  catch(error){
   const reason=record(error)?error.reason_code:undefined;
   const reason_code=typeof reason==='string'&&/^[a-z][a-z0-9_]{0,79}$/.test(reason)?reason:'result_validation_failed';
   const safe=new ModelApiError('invalid_response',false,null,null,null,reason_code);
   withLogContext({component:'llm_api',provider:input.config.provider,model:input.config.model,...(input.call_id?{call_id:input.call_id}:{})},()=>logEvent('model_api.validation.failed',{level:'error',...classifyLogError(safe)}));
   throw safe;
  }
 }};
}
