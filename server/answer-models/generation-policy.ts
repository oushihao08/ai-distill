/**
 * 职责：验证项目作答请求上限、推理增量认定阈值及免评分开关。
 * 关键入口：分钟配置解析、持久化策略读取和本地超时免评分资格判断；不调用数据库或模型。
 */
export interface AnswerGenerationPolicy {
 request_timeout_ms:number;
 reasoning_threshold_ms:number;
 skip_scoring_on_qualified_timeout:boolean;
}
export interface ReasoningActivityEvidence {
 source:'openrouter_reasoning_details'|'openrouter_reasoning'|'dashscope_reasoning_content';
 first_event_at:string;
 last_event_at:string;
 span_ms:number;
 max_gap_ms:number;
 event_count:number;
}
export interface AnswerCallSettings {timeout_ms:number;observe_reasoning:boolean}
export const DEFAULT_ANSWER_GENERATION_POLICY:AnswerGenerationPolicy={
 request_timeout_ms:3_600_000,
 reasoning_threshold_ms:2_700_000,
 skip_scoring_on_qualified_timeout:false,
};
export const MAX_REASONING_EVENT_GAP_MS=120_000;
const MAX_TIMEOUT_MINUTES=Math.floor(2_147_483_647/60_000);
const reasoningSources=new Set<ReasoningActivityEvidence['source']>(['openrouter_reasoning_details','openrouter_reasoning','dashscope_reasoning_content']);
// No exact provider/model route is enrolled: stream protocol support alone does not prove bounded delivery gaps.
const timingValidatedReasoningSources:ReadonlySet<ReasoningActivityEvidence['source']>=new Set();
function record(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function exactFields(value:Record<string,unknown>,fields:string[]){return Object.keys(value).every(key=>fields.includes(key))&&fields.every(key=>Object.hasOwn(value,key));}
function minute(value:unknown){return Number.isSafeInteger(value)&&Number(value)>=1&&Number(value)<=MAX_TIMEOUT_MINUTES;}
function invalid(message='作答时长设置无效'):never{throw new Error(message);}

export function readAnswerGenerationPolicyFromStepConfig(value:unknown):AnswerGenerationPolicy{
 const raw=record(value)?value.answer_generation_policy:undefined;
 return resolveAnswerGenerationPolicy(raw);
}

export function answerProviderConfigFromStepConfig(value:unknown):Record<string,unknown>{
 if(!record(value))return{};
 const{answer_generation_policy:_,...provider}=value;
 return provider;
}

export function mergeAnswerGenerationPolicyIntoStepConfig(value:unknown,policy:AnswerGenerationPolicy):Record<string,unknown>{
 if(value!==undefined&&value!==null&&!record(value))throw new Error('作答步骤配置无效');
 return{...(record(value)?value:{}),answer_generation_policy:resolveAnswerGenerationPolicy(policy)};
}

export function serializeAnswerGenerationPolicyMinutes(value:unknown,source?:'default'|'project'){
 const configured=value!==undefined&&value!==null;
 const policy=resolveAnswerGenerationPolicy(value);
 return{
  request_timeout_minutes:policy.request_timeout_ms/60_000,
  reasoning_threshold_minutes:policy.reasoning_threshold_ms/60_000,
  skip_scoring_on_qualified_timeout:policy.skip_scoring_on_qualified_timeout,
  source:source??(configured?'project':'default'),
 } as const;
}

export function resolveAnswerCallSettings(policy:AnswerGenerationPolicy):AnswerCallSettings{
 return{timeout_ms:policy.request_timeout_ms,observe_reasoning:false};
}

export function parseAnswerGenerationPolicyMinutes(value:unknown):AnswerGenerationPolicy{
 if(!record(value)||!exactFields(value,['request_timeout_minutes','reasoning_threshold_minutes','skip_scoring_on_qualified_timeout'])||!minute(value.request_timeout_minutes)||!minute(value.reasoning_threshold_minutes)||typeof value.skip_scoring_on_qualified_timeout!=='boolean')return invalid();
 if(Number(value.reasoning_threshold_minutes)>=Number(value.request_timeout_minutes))return invalid();
 if(value.skip_scoring_on_qualified_timeout)return invalid('供应商／模型的推理流连续性尚未验证，自动免评分暂不可用');
 return{request_timeout_ms:Number(value.request_timeout_minutes)*60_000,reasoning_threshold_ms:Number(value.reasoning_threshold_minutes)*60_000,skip_scoring_on_qualified_timeout:false};
}

export function resolveAnswerGenerationPolicy(value:unknown):AnswerGenerationPolicy{
 if(value===undefined||value===null)return{...DEFAULT_ANSWER_GENERATION_POLICY};
 if(!record(value)||!exactFields(value,['request_timeout_ms','reasoning_threshold_ms','skip_scoring_on_qualified_timeout']))return invalid();
 const request_timeout_minutes=Number(value.request_timeout_ms)/60_000,reasoning_threshold_minutes=Number(value.reasoning_threshold_ms)/60_000;
 if(!Number.isInteger(request_timeout_minutes)||!Number.isInteger(reasoning_threshold_minutes)||typeof value.skip_scoring_on_qualified_timeout!=='boolean')return invalid();
 // A previously stored opt-in is treated as disabled until a provider/model route passes the evidence gate.
 return parseAnswerGenerationPolicyMinutes({request_timeout_minutes,reasoning_threshold_minutes,skip_scoring_on_qualified_timeout:false});
}

export function isQualifiedLongGenerationTimeout(error:unknown,policy:AnswerGenerationPolicy):boolean{
 if(!policy.skip_scoring_on_qualified_timeout||!record(error)||error.kind!=='timeout'||error.reason_code!=='local_deadline')return false;
 const activity=error.generation_activity;
 if(!record(activity)||typeof activity.source!=='string'||!reasoningSources.has(activity.source as ReasoningActivityEvidence['source']))return false;
 if(!timingValidatedReasoningSources.has(activity.source as ReasoningActivityEvidence['source']))return false;
 if(typeof activity.first_event_at!=='string'||!Number.isFinite(Date.parse(activity.first_event_at))||typeof activity.last_event_at!=='string'||!Number.isFinite(Date.parse(activity.last_event_at)))return false;
 return Number.isSafeInteger(activity.span_ms)&&Number(activity.span_ms)>policy.reasoning_threshold_ms
  &&Number.isSafeInteger(activity.max_gap_ms)&&Number(activity.max_gap_ms)>=0&&Number(activity.max_gap_ms)<=MAX_REASONING_EVENT_GAP_MS
  &&Number.isSafeInteger(activity.event_count)&&Number(activity.event_count)>=2;
}
