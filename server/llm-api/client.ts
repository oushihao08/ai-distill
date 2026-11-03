/**
 * 职责：独立的纯文字大模型 API 客户端，统一消息调用、JSON 输出、完整响应、安全错误、超时和取消。
 * 关键入口：createModelApiClient().complete() / completeJson()；由作答、API评分及项目钩子复用，不访问工作目录或Agent。
 * 只调用冻结配置指定的供应商；不自动换模型或供应商，不在模块内重试收费请求。
 */
import {withModelApiSlot} from './concurrency';
import {resolveModelApiConfig,readModelApiKey} from './config';
import {ModelApiError,type ModelApiErrorKind,type ModelApiConfig,type ModelApiRequest,type ModelApiResult,type ReasoningActivityEvidence} from './types';
import {classifyLogError,logEvent,withLogContext} from '../logging';
function record(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function callerAbortError(signal?:AbortSignal):ModelApiError{
 const reason=signal?.reason;
 const known=new Set(['redaction_task_timeout','redaction_request_timeout','redaction_progress_stalled']);
 // Preserve only known control reasons, never arbitrary caller messages or private causes.
 if(record(reason)&&typeof reason.reason_code==='string'&&known.has(reason.reason_code))return new ModelApiError('timeout',false,null,null,null,reason.reason_code);
 return new ModelApiError('cancelled',false,null,null,null,'caller_cancelled');
}
function onlyFields(value:unknown,fields:string[]):asserts value is Record<string,unknown>{if(!record(value)||Object.keys(value).some(key=>!fields.includes(key)))throw new ModelApiError('configuration');}
function networkFailureReason(error:unknown):string{
 let current:unknown=error;
 for(let depth=0;depth<4&&current;depth++){
  if(!record(current))break;
  const code=typeof current.code==='string'?current.code:'';
  const known:Record<string,string>={ENOTFOUND:'dns_lookup_failed',EAI_NONAME:'dns_lookup_failed',EAI_AGAIN:'dns_temporary_failure',ECONNREFUSED:'connection_refused',ECONNRESET:'connection_reset',ETIMEDOUT:'connection_timeout',EHOSTUNREACH:'host_unreachable',ENETUNREACH:'network_unreachable',EPIPE:'connection_broken',UND_ERR_CONNECT_TIMEOUT:'connect_timeout',UND_ERR_SOCKET:'socket_failure',TimeoutError:'socket_idle_timeout',ConnectionClosed:'connection_closed',FailedToOpenSocket:'connection_failed'};
  if(known[code])return known[code]!;
  if(code.startsWith('ERR_TLS')||code.startsWith('CERT_'))return'tls_failure';
  current=current.cause;
 }
 return'fetch_failed';
}
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
function generationId(response:Response|null):string|null{
 const id=response?.headers.get('x-generation-id');
 return typeof id==='string'&&/^gen-[A-Za-z0-9_-]{6,128}$/.test(id)?id:null;
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
 return new ModelApiError(kind, retryable, response.status, code, requestId(response, data),response.status===408?'provider_http_408':undefined);
}
/** JSON完整消息与SSE增量共用纯文字契约；缺省、null或空工具数组不代表工具调用。 */
function unsupportedMessageReason(message:Record<string,unknown>):string|undefined{
 if((message.tool_calls!=null&&(!Array.isArray(message.tool_calls)||message.tool_calls.length>0))||message.function_call!=null)return 'unexpected_tool_call';
 if(message.refusal!=null)return 'refusal_response';
}
function parseCompletion(data: unknown, response: Response, config: ModelApiConfig, started_at: string, started: number): ModelApiResult {
 const invalid = (reason_code:string) => new ModelApiError('invalid_response', false, response.status, null, requestId(response, data),reason_code);
 if (!record(data) || data.error !== undefined || !Array.isArray(data.choices)) throw invalid('invalid_response_shape');
 if(data.choices.length!==1)throw invalid(data.choices.length===0?'missing_choice':'unexpected_choice_count');
 const choice = data.choices[0];
 if (!record(choice)) throw invalid('invalid_choice_shape');
 if(choice.finish_reason!=='stop')throw Object.assign(invalid('incomplete_finish_reason'),{finish_reason:['length','content_filter','tool_calls'].includes(String(choice.finish_reason))?choice.finish_reason:'unknown'});
 if(!record(choice.message))throw invalid('invalid_message_shape');
 const message = choice.message;
 if(message.role!=='assistant')throw invalid('invalid_message_role');
 if(typeof message.content!=='string'||!message.content.trim())throw invalid('empty_content');
 const unsupported=unsupportedMessageReason(message);if(unsupported)throw invalid(unsupported);
 return {
  provider:config.provider,text: message.content, requested_model: config.model, model: typeof data.model === 'string' ? data.model : null,
  request_id: requestId(response, data), completion_id: typeof data.id === 'string' ? data.id : null,
  usage: record(data.usage) ? data.usage : null,
  started_at, finished_at: new Date().toISOString(), duration_ms: Math.max(0, Math.round(performance.now() - started)),
 };
}

function hasOpenRouterReasoningText(value:unknown):boolean{
 return Array.isArray(value)&&value.some(item=>record(item)&&item.type==='reasoning.text'&&typeof item.text==='string'&&item.text.trim().length>0);
}
type AbortableReadResult={done:true;value?:Uint8Array}|{done:false;value:Uint8Array};
function readWithAbort(reader:ReadableStreamDefaultReader<Uint8Array>,signal:AbortSignal):Promise<AbortableReadResult>{
 return new Promise((resolve,reject)=>{
  let settled=false;
  const cleanup=()=>signal.removeEventListener('abort',onAbort);
  const onAbort=()=>{if(settled)return;settled=true;cleanup();reject(new Error('aborted'));};
  signal.addEventListener('abort',onAbort,{once:true});
  if(signal.aborted){onAbort();return;}
  reader.read().then(value=>{if(settled)return;settled=true;cleanup();resolve(value as AbortableReadResult);},error=>{if(settled)return;settled=true;cleanup();reject(error);});
 });
}
/** 截止/取消错误重新归类时保留已净化的流证据，不带入供应商响应正文。 */
function streamFailureEvidence(error:unknown){
 const {stream_events,stream_bytes,saw_done,saw_finish,stream_eof}=classifyLogError(error);
 return{stream_events,stream_bytes,saw_done,saw_finish,stream_eof};
}
async function parseStreamingCompletion(response:Response,config:ModelApiConfig,started_at:string,started:number,signal:AbortSignal):Promise<ModelApiResult>{
 const reader=response.body?.getReader();
 if(!reader)throw new ModelApiError('invalid_response',false,response.status,null,requestId(response,null),'missing_stream_body');
 const openRouter=new URL(config.base_url).hostname==='openrouter.ai';
 const dashScopeQwen=config.provider==='qwen'&&!openRouter;
 const decoder=new TextDecoder();let buffer='',dataLines:string[]=[],text='',model:string|null=null,completion_id:string|null=null,usage:Record<string,unknown>|null=null,finished=false,done=false;
 let streamEvents=0,streamBytes=0,sawFinish=false,streamEnd='reading';
 const streamDetails=()=>({stream_events:streamEvents,stream_bytes:streamBytes,saw_done:done,saw_finish:sawFinish,stream_eof:streamEnd});
 let firstReasoningAt:number|undefined,lastReasoningAt:number|undefined,maxGap=0,eventCount=0,activitySource:ReasoningActivityEvidence['source']|undefined,firstEventAt:string|undefined,lastEventAt:string|undefined;
 const activity=():ReasoningActivityEvidence|undefined=>firstReasoningAt===undefined||lastReasoningAt===undefined||!activitySource?undefined:{source:activitySource,first_event_at:firstEventAt!,last_event_at:lastEventAt!,span_ms:Math.max(0,Math.round(lastReasoningAt-firstReasoningAt)),max_gap_ms:maxGap,event_count:eventCount};
 const invalid=(reason_code:string)=>Object.assign(new ModelApiError('invalid_response',false,response.status,null,requestId(response,null),reason_code,activity()),streamDetails());
 const observe=(source:ReasoningActivityEvidence['source'])=>{
  const elapsed=performance.now()-started,at=new Date().toISOString();
  if(firstReasoningAt===undefined){firstReasoningAt=elapsed;firstEventAt=at;activitySource=source;}
  else if(activitySource!==source){return;}
  if(lastReasoningAt!==undefined)maxGap=Math.max(maxGap,Math.round(elapsed-lastReasoningAt));
  lastReasoningAt=elapsed;lastEventAt=at;eventCount++;
 };
 const handleEvent=(raw:string)=>{
  const payload=raw.trim();if(!payload)return;
  streamEvents++;
  if(payload==='[DONE]'){done=true;streamEnd='done';return;}
  let data:unknown;try{data=JSON.parse(payload);}catch{throw invalid('invalid_stream_json');}
  if(!record(data)||data.error!==undefined)throw invalid('invalid_stream_event');
  if(typeof data.model==='string')model=data.model;
  if(typeof data.id==='string')completion_id=data.id;
  if(record(data.usage))usage=data.usage;
  if(!Array.isArray(data.choices))throw invalid('invalid_stream_choices');
  if(data.choices.length===0)return;
  if(data.choices.length!==1||!record(data.choices[0]))throw invalid(data.choices.length>1?'unexpected_choice_count':'invalid_choice_shape');
  const choice=data.choices[0];
  if(choice.finish_reason!==undefined&&choice.finish_reason!==null){sawFinish=true;if(choice.finish_reason!=='stop')throw Object.assign(invalid('incomplete_finish_reason'),{finish_reason:['length','content_filter','tool_calls'].includes(String(choice.finish_reason))?choice.finish_reason:'unknown'});finished=true;}
  const delta=choice.delta;
  if(delta===undefined||delta===null)return;
  if(!record(delta))throw invalid('invalid_stream_delta');
  if(typeof delta.role==='string'&&delta.role!=='assistant')throw invalid('invalid_message_role');
  const unsupported=unsupportedMessageReason(delta);if(unsupported)throw invalid(unsupported);
  if(typeof delta.content==='string')text+=delta.content;
  if(openRouter&&hasOpenRouterReasoningText(delta.reasoning_details))observe('openrouter_reasoning_details');
  else if(openRouter&&typeof delta.reasoning==='string'&&delta.reasoning.length)observe('openrouter_reasoning');
  else if(dashScopeQwen&&typeof delta.reasoning_content==='string'&&delta.reasoning_content.length)observe('dashscope_reasoning_content');
 };
 const consumeLine=(line:string)=>{
  if(line===''){const raw=dataLines.join('\n');dataLines=[];if(raw)handleEvent(raw);return;}
  if(line.startsWith('data:'))dataLines.push(line.slice(5).replace(/^ /,''));
 };
 try{
  while(!done){
   const {done:ended,value}=await readWithAbort(reader,signal);
   if(ended){streamEnd='eof';buffer+=decoder.decode();for(const line of buffer.split(/\r?\n/))consumeLine(line);buffer='';if(dataLines.length)handleEvent(dataLines.join('\n'));break;}
   streamBytes+=value.byteLength;
   buffer+=decoder.decode(value,{stream:true});
   const lines=buffer.split(/\r?\n/);buffer=lines.pop()??'';for(const line of lines)consumeLine(line);
  }
 }catch(error){if(error instanceof ModelApiError)throw error;streamEnd='error';throw Object.assign(new ModelApiError('network',true,response.status,null,requestId(response,null),networkFailureReason(error),activity()),streamDetails());}
 finally{
  // [DONE]或异常后不再持有响应读取器；清理不延长调用截止，也不改变有效结束条件。
  void reader.cancel().catch(error=>logEvent('model_api.stream_cleanup_failed',{level:'warn',...classifyLogError(error)}));
  reader.releaseLock();
 }
 if(!finished)throw Object.assign(invalid('incomplete_finish_reason'),{finish_reason:'missing'});
 if(!text.trim())throw invalid('empty_content');
 return{provider:config.provider,text,requested_model:config.model,model,request_id:requestId(response,{id:completion_id}),completion_id,usage,started_at,finished_at:new Date().toISOString(),duration_ms:Math.max(0,Math.round(performance.now()-started)),...(activity()?{generation_activity:activity()!}:{})};
}

export function createModelApiClient(env: NodeJS.ProcessEnv = process.env, request: (input: string, init?: RequestInit) => Promise<Response> = fetch) {
 const client={ async complete(input: ModelApiRequest): Promise<ModelApiResult> {
  onlyFields(input,['config','messages','timeout_ms','queue_timeout_ms','signal','response_format','call_id','observe_reasoning']);
  if(input.observe_reasoning!==undefined&&typeof input.observe_reasoning!=='boolean')throw new ModelApiError('configuration');
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
  if (input.signal?.aborted) throw callerAbortError(input.signal);
  const config = resolveModelApiConfig(input.config, env);
  // Resolve credentials at invocation time, outside the persisted configuration.
  const router = new URL(config.base_url).hostname === 'openrouter.ai';
  const key=readModelApiKey(config,env);
  // OpenRouter与SiliconFlow长答案使用已有SSE解析器，避免长时间等待单个JSON响应；
  // 传输方式不改变作答输入、模型路由或完整性门槛。
  const stream=router||input.observe_reasoning===true||config.provider==='siliconflow';
  const started_at = new Date().toISOString(); const started = performance.now();
  const controller = new AbortController();
  let abortKind: 'timeout' | 'cancelled' | undefined;
  let generationActivity:ReasoningActivityEvidence|undefined;
  let receivedResponse:Response|null=null;
  const abort = (kind: 'timeout' | 'cancelled') => {
   if (!controller.signal.aborted) { abortKind = kind; controller.abort(kind==='cancelled'?input.signal?.reason:undefined); }
  };
  const cancel = () => abort('cancelled');
  const abortError=()=>abortKind==='timeout'?new ModelApiError('timeout',true,null,null,receivedResponse?requestId(receivedResponse,null):null,'local_deadline',generationActivity,generationId(receivedResponse)):callerAbortError(input.signal);
  input.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => abort('timeout'), timeout);
  const callContext={component:'llm_api',provider:config.provider,model:config.model,call_id:input.call_id??crypto.randomUUID()};
  try {
   withLogContext(callContext,()=>logEvent('model_api.call.started',{level:'info',timeout_ms:timeout}));
   const response = await request(config.base_url + '/chat/completions', {
    method: 'POST', redirect: 'error', signal: controller.signal,
    // Bun默认空闲超时独立于AbortSignal；统一由上面的业务总时限和取消信号控制。
    timeout: false,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
     model: config.model, stream,
     ...(stream&&(router||config.provider==='siliconflow')?{stream_options:{include_usage:true}}:{}),
     ...(config.enable_thinking !== undefined ? (router ? {reasoning:{enabled:config.enable_thinking}} : {enable_thinking:config.enable_thinking}) : {}),
     ...(input.response_format?{response_format:input.response_format}:{}),
     ...(router&&(config.provider_options||input.response_format||config.enable_thinking!==undefined)?{provider:{...config.provider_options,require_parameters:true}}:{}),
     ...(config.max_tokens !== undefined ? { max_tokens: config.max_tokens } : {}),
     messages,
    }),
   } as RequestInit & {timeout:false});
   receivedResponse=response;
   if (abortKind) throw abortError();
   if(stream&&response.ok){
    try{
     const result=await parseStreamingCompletion(response,config,started_at,started,controller.signal);
     generationActivity=result.generation_activity;
     withLogContext(callContext,()=>logEvent('model_api.call.completed',{level:'info',elapsed_ms:result.duration_ms,token_usage:result.usage,output_bytes:Buffer.byteLength(result.text),...(result.generation_activity?{reasoning_event_count:result.generation_activity.event_count,reasoning_span_ms:result.generation_activity.span_ms,reasoning_max_gap_ms:result.generation_activity.max_gap_ms}:{})}));
     return result;
    }catch(error){if(error instanceof ModelApiError){generationActivity=error.generation_activity??generationActivity;throw error;}throw error;}
   }
   let data: unknown;
   try { data = await response.json(); }
   catch (error) {
    if (abortKind) throw abortError();
    if (!(error instanceof SyntaxError)) throw new ModelApiError('network', true,response.status, null,requestId(response,null),networkFailureReason(error));
    if (response.ok) throw new ModelApiError('invalid_response', false, response.status, null, requestId(response, null),'invalid_json');
    data = null;
   }
   if (abortKind) throw abortError();
   if (!response.ok) throw providerError(response, data,config);
   const result=parseCompletion(data,response,config,started_at,started);
   withLogContext(callContext,()=>logEvent('model_api.call.completed',{level:'info',elapsed_ms:result.duration_ms,token_usage:result.usage,output_bytes:Buffer.byteLength(result.text)}));
   return result;
  } catch (error) {
   const failure=abortKind?Object.assign(abortError(),streamFailureEvidence(error)):error instanceof ModelApiError?error:new ModelApiError('network',true,null,null,null,networkFailureReason(error));
   withLogContext(callContext,()=>logEvent('model_api.call.failed',{level:'error',elapsed_ms:Math.round(performance.now()-started),...classifyLogError(failure)}));
   throw failure;
  } finally {
   clearTimeout(timer);
   input.signal?.removeEventListener('abort', cancel);
  }
 } };
 // 注入的HTTP替身不访问本机槽位；生产默认传输的所有入口（含completeJson）共用同一请求上限。
 const complete=async(input:ModelApiRequest):Promise<ModelApiResult>=>{
  if(request!==fetch)return await client.complete(input);
  if(input.signal!==undefined&&!(input.signal instanceof AbortSignal)||input.timeout_ms!==undefined&&(!Number.isInteger(input.timeout_ms)||input.timeout_ms<=0||input.timeout_ms>2147483647))throw new ModelApiError('configuration');
  const controller=new AbortController(),cancel=()=>controller.abort(input.signal?.reason);let queue_wait_ms=0;
  let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},input.timeout_ms??3600000);
  input.signal?.addEventListener('abort',cancel,{once:true});if(input.signal?.aborted)cancel();
  try{const result=await withModelApiSlot(()=>client.complete({...input,signal:controller.signal}),{env,signal:controller.signal,queue_timeout_ms:input.queue_timeout_ms,onAcquired:wait_ms=>{queue_wait_ms=wait_ms;}});return{...result,queue_wait_ms};}
  catch(error){if(timedOut){const wait=record(error)&&typeof error.queue_wait_ms==='number'?error.queue_wait_ms:queue_wait_ms;const timeoutError=error instanceof ModelApiError?new ModelApiError('timeout',true,error.http_status,error.provider_code,error.request_id,'local_deadline',error.generation_activity,error.generation_id):new ModelApiError('timeout',true,null,null,null,'local_deadline');throw Object.assign(timeoutError,{...streamFailureEvidence(error),queue_wait_ms:wait});}throw error;}
  finally{clearTimeout(timer);input.signal?.removeEventListener('abort',cancel);}
 };
 return{complete,async completeJson<T>(input:ModelApiRequest,validate:(value:unknown)=>T):Promise<ModelApiResult&{result:T}>{
  const completion=await complete({...input,response_format:input.response_format??{type:'json_object'}});
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
